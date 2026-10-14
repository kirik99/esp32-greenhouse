#include "camera_diag.h"
#include "esp_camera.h"
#include "config.h"
#include "camera_pins.h"

static bool camera_initialized = false;
static sensor_t *cam_sensor = NULL;
static const char *detected_sensor_model = "Unknown / Undetected";

static const char* resolve_sensor_model(uint16_t pid) {
  switch (pid) {
    case 0x0026:
    case 0x2640:
    case 0x2641:
    case 0x2642:
      return "OV2640 (2 Megapixel DVP)";
    case 0x0036:
    case 0x3660:
      return "OV3660 (3 Megapixel DVP)";
    case 0x0056:
    case 0x5640:
      return "OV5640 (5 Megapixel DVP)";
    case 0x7725:
      return "OV7725 (VGA DVP)";
    case 0x7670:
      return "OV7670 (VGA DVP)";
    case 0x9650:
      return "OV9650 (1.3 Megapixel DVP)";
    case 0x9914:
      return "NT99141 (HD DVP)";
    default:
      if ((pid & 0xFF) == 0x26 || (pid >> 8) == 0x26) return "OV2640 Variant";
      if ((pid & 0xFF) == 0x36 || (pid >> 8) == 0x36) return "OV3660 Variant";
      if ((pid & 0xFF) == 0x56 || (pid >> 8) == 0x56) return "OV5640 Variant";
      return "Compatible DVP Sensor";
  }
}

bool init_camera() {
  Serial.println("\n[STAGE C] ===============================================");
  Serial.println("[STAGE C] Starting DVP Camera Diagnostics (esp_camera)");
  Serial.printf("[STAGE C] Active Pin Profile: %s\n", CAM_PROFILE_NAME);
  Serial.println("[STAGE C] ===============================================");

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = Y2_GPIO_NUM;
  config.pin_d1       = Y3_GPIO_NUM;
  config.pin_d2       = Y4_GPIO_NUM;
  config.pin_d3       = Y5_GPIO_NUM;
  config.pin_d4       = Y6_GPIO_NUM;
  config.pin_d5       = Y7_GPIO_NUM;
  config.pin_d6       = Y8_GPIO_NUM;
  config.pin_d7       = Y9_GPIO_NUM;
  config.pin_xclk     = XCLK_GPIO_NUM;
  config.pin_pclk     = PCLK_GPIO_NUM;
  config.pin_vsync    = VSYNC_GPIO_NUM;
  config.pin_href     = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn     = PWDN_GPIO_NUM;
  config.pin_reset    = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.frame_size   = FRAMESIZE_QVGA; // 320x240 minimal reliable resolution
    config.jpeg_quality = 12;
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
    Serial.println("[CAMERA] Framebuffers configured in Octal PSRAM (fb_count=2).");
  } else {
    config.frame_size   = FRAMESIZE_QQVGA; // 160x120 fallback without PSRAM
    config.jpeg_quality = 16;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
    Serial.println("[CAMERA WARN] No PSRAM: Allocating minimal buffer in DRAM.");
  }

  Serial.println("[CAMERA] Initializing esp_camera driver...");
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAMERA ERR] esp_camera_init failed with error 0x%x (%s)!\n", err, esp_err_to_name(err));
    Serial.println("[CAMERA ERR] Possible causes:");
    Serial.println("  1. FPC/FFC ribbon cable is not fully inserted or inverted;");
    Serial.println("  2. Incorrect camera pin definitions in camera_pins.h;");
    Serial.println("  3. Sensor requires a different XCLK frequency;");
    Serial.println("  4. Insufficient power supply / 3.3V rail voltage sag during sensor power-up.");
    camera_initialized = false;
    return false;
  }

  camera_initialized = true;
  cam_sensor = esp_camera_sensor_get();
  if (cam_sensor) {
    detected_sensor_model = resolve_sensor_model(cam_sensor->id.PID);
    Serial.printf("[CAMERA] Sensor Model Detected: %s\n", detected_sensor_model);
    Serial.printf("[CAMERA] Sensor ID: PID=0x%04X, MIDH=0x%02X, MIDL=0x%02X, VER=0x%02X\n", 
                  cam_sensor->id.PID, cam_sensor->id.MIDH, cam_sensor->id.MIDL, cam_sensor->id.VER);
  } else {
    Serial.println("[CAMERA WARN] esp_camera_sensor_get() returned NULL.");
  }

  Serial.println("[CAMERA] Initialization: OK");

  // Perform immediate test snapshot to verify capture pipeline
  Serial.println("[CAMERA] Performing initial test capture...");
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAMERA ERR] Initial frame capture returned NULL!");
    return false;
  }

  bool valid_jpeg = (fb->len > 4 && fb->buf[0] == 0xFF && fb->buf[1] == 0xD8);
  Serial.printf("[CAMERA] Initial frame captured: %u bytes (%ux%u), format=%d\n",
                (unsigned int)fb->len, (unsigned int)fb->width, (unsigned int)fb->height, fb->format);
  Serial.printf("[CAMERA] JPEG Header Validation: %s (Magic: 0x%02X 0x%02X)\n",
                valid_jpeg ? "PASS (Valid JPEG)" : "FAIL (Corrupted payload)", fb->buf[0], fb->buf[1]);

  esp_camera_fb_return(fb);
  Serial.println("[CAMERA] Buffer released. Initial camera test: SUCCESS\n");
  return true;
}

bool capture_single_photo(uint32_t shot_number) {
  if (!camera_initialized) {
    Serial.println("[CAMERA ERR] Cannot capture: Camera is not initialized.");
    return false;
  }

  uint32_t psram_before = ESP.getFreePsram();
  uint32_t heap_before  = ESP.getFreeHeap();

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.printf("[CAMERA ERR] Shot #%u: esp_camera_fb_get() failed (NULL buffer)!\n", shot_number);
    return false;
  }

  bool valid_jpeg = (fb->len > 4 && fb->buf[0] == 0xFF && fb->buf[1] == 0xD8);

  Serial.printf("[CAMERA] Shot #%u: OK | %u bytes | Resolution: %ux%u | Valid JPEG: %s | Free Heap: %u | Free PSRAM: %u\n",
                shot_number,
                (unsigned int)fb->len,
                (unsigned int)fb->width,
                (unsigned int)fb->height,
                valid_jpeg ? "YES" : "NO",
                (unsigned int)ESP.getFreeHeap(),
                (unsigned int)ESP.getFreePsram());

  esp_camera_fb_return(fb);

  uint32_t psram_after = ESP.getFreePsram();
  uint32_t heap_after  = ESP.getFreeHeap();

  if (psram_after < psram_before - 1024) {
    Serial.printf("[CAMERA WARN] Possible PSRAM leak detected: delta = %d bytes\n", (int)(psram_before - psram_after));
  }

  return valid_jpeg;
}

bool capture_and_dump_base64() {
  if (!camera_initialized) {
    Serial.println("[CAMERA ERR] Cannot capture: Camera is not initialized.");
    return false;
  }

  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    Serial.println("[CAMERA ERR] esp_camera_fb_get() returned NULL!");
    return false;
  }

  Serial.printf("[CAMERA] Frame captured: %u bytes (%ux%u). Streaming Base64...\n", 
                (unsigned int)fb->len, (unsigned int)fb->width, (unsigned int)fb->height);
  Serial.println("-----BEGIN JPEG BASE64-----");

  static const char b64_chars[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t i = 0;
  char line[65];
  size_t line_idx = 0;

  while (i < fb->len) {
    uint32_t octet_a = i < fb->len ? (unsigned char)fb->buf[i++] : 0;
    uint32_t octet_b = i < fb->len ? (unsigned char)fb->buf[i++] : 0;
    uint32_t octet_c = i < fb->len ? (unsigned char)fb->buf[i++] : 0;
    uint32_t triple = (octet_a << 16) + (octet_b << 8) + octet_c;

    line[line_idx++] = b64_chars[(triple >> 18) & 0x3F];
    line[line_idx++] = b64_chars[(triple >> 12) & 0x3F];
    line[line_idx++] = (i > fb->len + 1) ? '=' : b64_chars[(triple >> 6) & 0x3F];
    line[line_idx++] = (i > fb->len) ? '=' : b64_chars[triple & 0x3F];

    if (line_idx >= 64) {
      line[line_idx] = '\0';
      Serial.println(line);
      line_idx = 0;
    }
  }
  if (line_idx > 0) {
    line[line_idx] = '\0';
    Serial.println(line);
  }

  Serial.println("-----END JPEG BASE64-----");
  esp_camera_fb_return(fb);
  return true;
}

bool is_camera_ready() {
  return camera_initialized;
}

const char* get_detected_camera_model() {
  return detected_sensor_model;
}
