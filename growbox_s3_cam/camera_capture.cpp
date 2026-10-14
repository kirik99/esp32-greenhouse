#include "camera_capture.h"
#include "mqtt_transport.h"
#include "config.h"
#include "esp_camera.h"

static bool camera_ready = false;
static unsigned long last_photo_time = 0;
static bool initial_photo_sent = false;
static volatile bool force_capture = false;

// Base64 encoding table
static const char base64_chars[] = 
             "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
             "abcdefghijklmnopqrstuvwxyz"
             "0123456789+/";

static String base64_encode(const uint8_t *in, size_t in_len) {
  String out;
  out.reserve(((in_len + 2) / 3) * 4);
  int val = 0, valb = -6;
  for (size_t i = 0; i < in_len; i++) {
    val = (val << 8) + in[i];
    valb += 8;
    while (valb >= 0) {
      out += base64_chars[(val >> valb) & 0x3F];
      valb -= 6;
    }
  }
  if (valb > -6) out += base64_chars[((val << 8) >> (valb + 8)) & 0x3F];
  while (out.length() % 4) out += '=';
  return out;
}

void trigger_camera_capture() {
  Serial.println("[CAMERA] Manual snapshot capture triggered via MQTT!");
  force_capture = true;
}

bool is_camera_available() {
  return camera_ready;
}

void setup_camera() {
  Serial.printf("[CAMERA] psramFound: %d, free_psram: %u, free_heap: %u\n", 
                psramFound(), (unsigned int)ESP.getFreePsram(), (unsigned int)ESP.getFreeHeap());

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = CAM_PIN_Y2;
  config.pin_d1       = CAM_PIN_Y3;
  config.pin_d2       = CAM_PIN_Y4;
  config.pin_d3       = CAM_PIN_Y5;
  config.pin_d4       = CAM_PIN_Y6;
  config.pin_d5       = CAM_PIN_Y7;
  config.pin_d6       = CAM_PIN_Y8;
  config.pin_d7       = CAM_PIN_Y9;
  config.pin_xclk     = CAM_PIN_XCLK;
  config.pin_pclk     = CAM_PIN_PCLK;
  config.pin_vsync    = CAM_PIN_VSYNC;
  config.pin_href     = CAM_PIN_HREF;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_pwdn     = CAM_PIN_PWDN;
  config.pin_reset    = CAM_PIN_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.grab_mode    = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.frame_size   = FRAMESIZE_QVGA; // 320x240
    config.jpeg_quality = 12;
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size   = FRAMESIZE_QQVGA;
    config.jpeg_quality = 16;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAMERA ERR] esp_camera_init failed: 0x%x (%s)\n", err, esp_err_to_name(err));
    camera_ready = false;
    return;
  }

  camera_ready = true;
  Serial.println("[CAMERA OK] OV2640 DVP camera initialized successfully!");
}

void process_camera() {
  if (!camera_ready) return;

  unsigned long now = millis();
  bool should_capture = false;

  // Initial photo 5s after startup once MQTT connects
  if (!initial_photo_sent && now > 5000 && mqtt_is_connected()) {
    should_capture = true;
  }

  // Periodic capture (every CAMERA_INTERVAL)
  if (now - last_photo_time >= CAMERA_INTERVAL && mqtt_is_connected()) {
    should_capture = true;
  }

  // Force capture triggered via MQTT
  if (force_capture && mqtt_is_connected()) {
    should_capture = true;
    force_capture = false;
  }

  if (should_capture) {
    initial_photo_sent = true;
    last_photo_time = now;

    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAMERA ERR] Frame capture returned NULL!");
      return;
    }

    Serial.printf("[CAMERA] Captured JPEG: %u bytes (%ux%u). Encoding Base64...\n",
                  (unsigned int)fb->len, (unsigned int)fb->width, (unsigned int)fb->height);

    String base64_img = base64_encode(fb->buf, fb->len);
    uint32_t w = fb->width;
    uint32_t h = fb->height;
    esp_camera_fb_return(fb);

    String json = "{\"format\":\"jpeg\",\"width\":" + String(w) + ",\"height\":" + String(h) + ",\"data\":\"" + base64_img + "\"}";
    Serial.printf("[CAMERA] Publishing image to MQTT (%u bytes payload)...\n", (unsigned int)json.length());
    mqtt_publish_image(json.c_str());
  }
}
