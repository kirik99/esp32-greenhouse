#include "camera_capture.h"
#include "mqtt_transport.h"
#include "config.h"
#include "esp_camera.h"

static bool camera_ready = false;
static unsigned long last_photo_time = 0;
static bool initial_photo_sent = false;
static volatile bool force_capture = false;

static void fast_base64_encode(const uint8_t *in, size_t in_len, char *out) {
  static const char b64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  size_t i = 0, j = 0;
  for (; i + 2 < in_len; i += 3) {
    uint32_t n = (in[i] << 16) | (in[i+1] << 8) | in[i+2];
    out[j++] = b64[(n >> 18) & 0x3F];
    out[j++] = b64[(n >> 12) & 0x3F];
    out[j++] = b64[(n >> 6) & 0x3F];
    out[j++] = b64[n & 0x3F];
  }
  if (i < in_len) {
    uint32_t n = in[i] << 16;
    out[j++] = b64[(n >> 18) & 0x3F];
    if (i + 1 < in_len) {
      n |= in[i+1] << 8;
      out[j++] = b64[(n >> 12) & 0x3F];
      out[j++] = b64[(n >> 6) & 0x3F];
      out[j++] = '=';
    } else {
      out[j++] = b64[(n >> 12) & 0x3F];
      out[j++] = '=';
      out[j++] = '=';
    }
  }
  out[j] = '\0';
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
    config.frame_size   = FRAMESIZE_HD;   // 1280x720 (16:9 widescreen HD - captures wider view without Wi-Fi timeouts)
    config.jpeg_quality = 12;             // High quality JPEG
    config.fb_count     = 2;
    config.fb_location  = CAMERA_FB_IN_PSRAM;
  } else {
    config.frame_size   = FRAMESIZE_SVGA;
    config.jpeg_quality = 14;
    config.fb_count     = 1;
    config.fb_location  = CAMERA_FB_IN_DRAM;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[CAMERA ERR] esp_camera_init failed: 0x%x (%s)\n", err, esp_err_to_name(err));
    camera_ready = false;
    return;
  }

  sensor_t *s = esp_camera_sensor_get();
  if (s) {
    s->set_brightness(s, 0);     // normal brightness (-2 to 2)
    s->set_contrast(s, 0);       // normal contrast (-2 to 2)
    s->set_saturation(s, 0);     // normal saturation (-2 to 2)
    s->set_sharpness(s, 1);      // boost sharpness for details (-2 to 2)
    s->set_whitebal(s, 1);       // enable auto white balance
    s->set_awb_gain(s, 1);       // enable awb gain
    s->set_wb_mode(s, 0);        // auto white balance mode
    s->set_exposure_ctrl(s, 1);  // auto exposure
    s->set_aec2(s, 1);           // auto exposure algorithm 2
    s->set_gain_ctrl(s, 1);      // auto gain control
    s->set_bpc(s, 1);            // black pixel correction
    s->set_wpc(s, 1);            // white pixel correction
    s->set_raw_gma(s, 1);        // gamma correction
    s->set_lenc(s, 1);           // lens distortion correction
    Serial.println("[CAMERA] Sensor tuned: UXGA 1600x1200, AWB, AEC, Sharpness, BPC/WPC enabled");
  }

  // Sensor warmup: discard first 2 frames to let AEC/AWB stabilize
  for (int i = 0; i < 2; i++) {
    camera_fb_t *warmup_fb = esp_camera_fb_get();
    if (warmup_fb) esp_camera_fb_return(warmup_fb);
    delay(40);
  }

  camera_ready = true;
  Serial.println("[CAMERA OK] OV2640 DVP camera initialized successfully at UXGA 1600x1200!");
}

void process_camera() {
  if (!camera_ready) return;

  unsigned long now = millis();
  bool should_capture = false;

  // Initial photo 20s after startup once sensors have settled and reported
  if (!initial_photo_sent && now > 20000 && mqtt_is_connected()) {
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
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("[CAMERA WARN] Frame acquisition returned NULL, retrying in 50ms...");
      delay(50);
      fb = esp_camera_fb_get();
    }

    if (!fb) {
      Serial.println("[CAMERA ERR] Frame capture returned NULL after retry!");
      return;
    }

    initial_photo_sent = true;
    last_photo_time = now;

    Serial.printf("[CAMERA] Captured JPEG: %u bytes (%ux%u). Encoding Base64...\n",
                  (unsigned int)fb->len, (unsigned int)fb->width, (unsigned int)fb->height);

    size_t b64_len = ((fb->len + 2) / 3) * 4;
    char header_buf[64];
    int header_len = snprintf(header_buf, sizeof(header_buf), 
                              "{\"format\":\"jpeg\",\"width\":%u,\"height\":%u,\"data\":\"",
                              (unsigned int)fb->width, (unsigned int)fb->height);

    size_t total_payload_len = header_len + b64_len + 4; // header + b64 + "\"}" + \0

    char *json_buf = (char *)heap_caps_malloc(total_payload_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!json_buf) {
      json_buf = (char *)malloc(total_payload_len);
    }

    if (!json_buf) {
      Serial.println("[CAMERA ERR] Failed to allocate memory for image payload!");
      esp_camera_fb_return(fb);
      return;
    }

    memcpy(json_buf, header_buf, header_len);
    fast_base64_encode(fb->buf, fb->len, json_buf + header_len);
    esp_camera_fb_return(fb);

    size_t current_len = header_len + b64_len;
    json_buf[current_len++] = '"';
    json_buf[current_len++] = '}';
    json_buf[current_len] = '\0';

    Serial.printf("[CAMERA] Publishing image to MQTT (%u bytes in PSRAM)...\n", (unsigned int)current_len);
    mqtt_publish_image(json_buf);

    free(json_buf);
  }
}
