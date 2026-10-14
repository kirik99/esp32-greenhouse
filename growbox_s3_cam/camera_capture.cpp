#include "camera_capture.h"
#include "mqtt_transport.h"
#include "config.h"
#include "esp_camera.h"
#include "wifi_config.h"
#include <WiFi.h>
#include <time.h>
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include <atomic>

#ifndef IMAGE_UPLOAD_URL
#define IMAGE_UPLOAD_URL ""
#endif
#ifndef IMAGE_UPLOAD_TOKEN
#define IMAGE_UPLOAD_TOKEN ""
#endif

static bool camera_ready = false;
static unsigned long last_photo_time = 0;
static bool initial_photo_sent = false;
static volatile bool force_capture = false;

static std::atomic<bool> upload_in_progress{false};

// The worker owns the camera frame until HTTP has finished. No Base64 allocation,
// no large MQTT packet, and no networking wait in the control/safety loop.
static void upload_photo_task(void *arg) {
  camera_fb_t *fb = static_cast<camera_fb_t *>(arg);
  bool ok = false;
  esp_http_client_handle_t client = nullptr;
  if (WiFi.status() == WL_CONNECTED) {
    if (time(nullptr) < 1704067200) {
      configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
      unsigned long start = millis();
      while (time(nullptr) < 1704067200 && millis() - start < 10000) delay(100);
    }
    if (time(nullptr) >= 1704067200) {
      esp_http_client_config_t cfg = {};
      cfg.url = IMAGE_UPLOAD_URL;
      cfg.method = HTTP_METHOD_POST;
      cfg.crt_bundle_attach = esp_crt_bundle_attach;
      cfg.timeout_ms = 5000;
      cfg.buffer_size = 4096;
      cfg.buffer_size_tx = 4096;
      cfg.disable_auto_redirect = true; // Never forward a device secret elsewhere.
      client = esp_http_client_init(&cfg);
      if (client) {
        esp_http_client_set_header(client, "Content-Type", "image/jpeg");
        esp_http_client_set_header(client, "X-Upload-Token", IMAGE_UPLOAD_TOKEN);
        unsigned long start = millis();
        esp_err_t err = esp_http_client_open(client, static_cast<int>(fb->len));
        size_t sent = 0;
        while (err == ESP_OK && sent < fb->len && millis() - start < 30000) {
          size_t chunk = fb->len - sent;
          if (chunk > 4096) chunk = 4096;
          int n = esp_http_client_write(client, reinterpret_cast<const char *>(fb->buf + sent), chunk);
          if (n <= 0) break;
          sent += n;
          vTaskDelay(1);
        }
        if (sent == fb->len && esp_http_client_fetch_headers(client) >= 0) {
          int status = esp_http_client_get_status_code(client);
          ok = status == 201;
          Serial.printf("[CAMERA HTTPS] HTTP %d, sent %u bytes\n", status, static_cast<unsigned>(sent));
        } else {
          Serial.printf("[CAMERA HTTPS] Transfer failed: %s, sent %u/%u bytes\n",
                        esp_err_to_name(err), static_cast<unsigned>(sent), static_cast<unsigned>(fb->len));
        }
      }
    } else Serial.println("[CAMERA HTTPS] No valid clock: TLS upload skipped");
  }
  if (client) {
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
  }
  esp_camera_fb_return(fb);
  Serial.println(ok ? "[CAMERA HTTPS] Photo uploaded" : "[CAMERA HTTPS] Upload failed; next scheduled capture will retry");
  upload_in_progress.store(false);
  vTaskDelete(nullptr);
}

void trigger_camera_capture() {
  Serial.println("[CAMERA] Manual snapshot capture triggered via MQTT!");
  force_capture = true;
}

bool is_camera_available() {
  return camera_ready;
}

void setup_camera() {
  if (strncmp(IMAGE_UPLOAD_URL, "https://", 8) != 0 || strlen(IMAGE_UPLOAD_TOKEN) < 32) {
    Serial.println("[CAMERA HTTPS] Configure IMAGE_UPLOAD_URL and a 32+ character IMAGE_UPLOAD_TOKEN in wifi_config.h");
  }
  Serial.printf("[CAMERA] psramFound: %d, free_psram: %u, free_heap: %u\n", 
                psramFound(), (unsigned int)ESP.getFreePsram(), (unsigned int)ESP.getFreeHeap());

  camera_config_t config = {};
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
  if (!camera_ready || upload_in_progress.load()) return;
  if (strncmp(IMAGE_UPLOAD_URL, "https://", 8) != 0 || strlen(IMAGE_UPLOAD_TOKEN) < 32) return;

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

    Serial.printf("[CAMERA] Captured JPEG: %u bytes (%ux%u). Uploading via HTTPS...\n",
                  (unsigned int)fb->len, (unsigned int)fb->width, (unsigned int)fb->height);

    if (fb->len > 1024 * 1024) {
      Serial.println("[CAMERA HTTPS] Frame exceeds 1 MiB limit");
      esp_camera_fb_return(fb);
      return;
    }
    upload_in_progress.store(true);
    if (xTaskCreate(upload_photo_task, "photo_https", 12288, fb, 1, nullptr) != pdPASS) {
      esp_camera_fb_return(fb);
      upload_in_progress.store(false);
      Serial.println("[CAMERA HTTPS] Could not start upload task");
    }
  }
}
