#include "camera_capture.h"
#include "diagnostics.h"
#include "mqtt_transport.h"
#include "config.h"
#include "esp_camera.h"
#include "wifi_config.h"
#include <WiFi.h>
#include <time.h>
#include <errno.h>
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include <atomic>
#include "camera_settings.h"
#include "ota_update.h"
#include "relay.h"

#ifndef IMAGE_UPLOAD_URL
#define IMAGE_UPLOAD_URL ""
#endif
#ifndef IMAGE_UPLOAD_TOKEN
#define IMAGE_UPLOAD_TOKEN ""
#endif

static std::atomic<bool> camera_ready{false};
static std::atomic<bool> force_capture{false};

enum CameraCaptureState {
  CAM_STATE_IDLE,
  CAM_STATE_WARMUP
};
static CameraCaptureState capture_state = CAM_STATE_IDLE;
static unsigned long warmup_start_ms = 0;
static const unsigned long LIGHT_WARMUP_MS = 3000;
static bool light_was_on_before_capture = false;

static std::atomic<bool> upload_in_progress{false};
bool camera_upload_busy() { return upload_in_progress.load(); }

// The worker owns the camera frame until HTTP has finished. No Base64 allocation,
// no large MQTT packet, and no networking wait in the control/safety loop.
static void upload_photo_task(void *arg) {
  camera_fb_t *fb = static_cast<camera_fb_t *>(arg);
  bool ok = false;
  esp_http_client_handle_t client = nullptr;
  if (WiFi.status() == WL_CONNECTED) {
    bool is_https = strncmp(IMAGE_UPLOAD_URL, "https://", 8) == 0;
    if (is_https && time(nullptr) < 1704067200) {
      configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
      unsigned long start = millis();
      while (time(nullptr) < 1704067200 && millis() - start < 10000) delay(100);
    }
    if (!is_https || time(nullptr) >= 1704067200) {
      esp_http_client_config_t cfg = {};
      cfg.url = IMAGE_UPLOAD_URL;
      cfg.method = HTTP_METHOD_POST;
      if (is_https) cfg.crt_bundle_attach = esp_crt_bundle_attach;
      cfg.timeout_ms = 5000;
      cfg.buffer_size = 4096;
      cfg.buffer_size_tx = 4096;
      cfg.disable_auto_redirect = true; // Never forward a device secret elsewhere.
      client = esp_http_client_init(&cfg);
      if (client) {
        esp_http_client_set_header(client, "Content-Type", "image/jpeg");
        esp_http_client_set_header(client, "X-Upload-Token", IMAGE_UPLOAD_TOKEN);
        unsigned long start = millis();
        DiagnosticSerial.printf("[CAMERA HTTPS] Opening connection: jpeg=%u bytes, free_heap=%u, rssi=%d\n",
                                static_cast<unsigned>(fb->len), ESP.getFreeHeap(), WiFi.RSSI());
        esp_err_t err = esp_http_client_open(client, static_cast<int>(fb->len));
        if (err != ESP_OK) DiagnosticSerial.printf("[CAMERA HTTPS] Open failed: %s (0x%x), errno=%d\n", esp_err_to_name(err), err, errno);
        size_t sent = 0;
        while (err == ESP_OK && sent < fb->len && millis() - start < 30000) {
          size_t chunk = fb->len - sent;
          if (chunk > 4096) chunk = 4096;
          int n = esp_http_client_write(client, reinterpret_cast<const char *>(fb->buf + sent), chunk);
          if (n <= 0) {
            DiagnosticSerial.printf("[CAMERA HTTPS] Write failed: result=%d errno=%d elapsed_ms=%lu\n", n, errno, millis() - start);
            break;
          }
          sent += n;
          vTaskDelay(1);
        }
        if (sent == fb->len && esp_http_client_fetch_headers(client) >= 0) {
          int status = esp_http_client_get_status_code(client);
          ok = status == 201;
          DiagnosticSerial.printf("[CAMERA HTTPS] HTTP %d, sent %u bytes\n", status, static_cast<unsigned>(sent));
        } else {
          DiagnosticSerial.printf("[CAMERA HTTPS] Transfer failed: %s, sent %u/%u bytes\n",
                        esp_err_to_name(err), static_cast<unsigned>(sent), static_cast<unsigned>(fb->len));
        }
      }
    } else DiagnosticSerial.println("[CAMERA HTTPS] No valid clock: TLS upload skipped");
  }
  if (client) {
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
  }
  esp_camera_fb_return(fb);
  DiagnosticSerial.println(ok ? "[CAMERA HTTPS] Photo uploaded" : "[CAMERA HTTPS] Upload failed; next scheduled capture will retry");
  upload_in_progress.store(false);
  vTaskDelete(nullptr);
}

void trigger_camera_capture() {
  if (upload_in_progress.load()) {
    DiagnosticSerial.println("[CAMERA] Capture request ignored: upload already in progress");
    return;
  }
  if (capture_state == CAM_STATE_WARMUP) {
    DiagnosticSerial.println("[CAMERA] Capture request received while already warming up light; request merged");
    return;
  }
  DiagnosticSerial.println("[CAMERA] Manual snapshot capture triggered via MQTT!");
  force_capture = true;
}

bool is_camera_available() {
  return camera_ready;
}

void setup_camera() {
  bool url_ok = (strncmp(IMAGE_UPLOAD_URL, "https://", 8) == 0 || strncmp(IMAGE_UPLOAD_URL, "http://", 7) == 0);
  if (!url_ok || strlen(IMAGE_UPLOAD_TOKEN) < 32) {
    DiagnosticSerial.println("[CAMERA] Configure valid HTTP/HTTPS IMAGE_UPLOAD_URL and a 32+ character IMAGE_UPLOAD_TOKEN in wifi_config.h");
  }
  DiagnosticSerial.printf("[CAMERA] psramFound: %d, free_psram: %u, free_heap: %u\n",
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
    DiagnosticSerial.printf("[CAMERA ERR] esp_camera_init failed: 0x%x (%s)\n", err, esp_err_to_name(err));
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
    DiagnosticSerial.println("[CAMERA] Sensor tuned: UXGA 1600x1200, AWB, AEC, Sharpness, BPC/WPC enabled");
  }

  // Sensor warmup: discard first 2 frames to let AEC/AWB stabilize
  for (int i = 0; i < 2; i++) {
    camera_fb_t *warmup_fb = esp_camera_fb_get();
    if (warmup_fb) esp_camera_fb_return(warmup_fb);
    delay(40);
  }

  camera_ready = true;
  DiagnosticSerial.println("[CAMERA OK] OV2640 DVP camera initialized successfully at UXGA 1600x1200!");
}

void process_camera() {
  bool url_ok = (strncmp(IMAGE_UPLOAD_URL, "https://", 8) == 0 || strncmp(IMAGE_UPLOAD_URL, "http://", 7) == 0);
  // Safety / abort conditions: ensure Relay 6 is restored if warmup was in progress
  if (ota_busy() || !camera_ready || WiFi.status() != WL_CONNECTED ||
      !url_ok || strlen(IMAGE_UPLOAD_TOKEN) < 32) {
    if (capture_state == CAM_STATE_WARMUP) {
      if (!light_was_on_before_capture) {
        set_relay(6, false);
        DiagnosticSerial.println("[CAMERA] Capture warmup cancelled: network/system condition changed. Light OFF.");
      } else {
        DiagnosticSerial.println("[CAMERA] Capture warmup cancelled: network/system condition changed. Light kept ON (was active before capture).");
      }
      capture_state = CAM_STATE_IDLE;
    }
    return;
  }

  if (upload_in_progress.load()) {
    if (capture_state == CAM_STATE_WARMUP) {
      if (!light_was_on_before_capture) {
        set_relay(6, false);
      }
      capture_state = CAM_STATE_IDLE;
    }
    return;
  }

  unsigned long now = millis();

  if (capture_state == CAM_STATE_IDLE) {
    bool auto_due = camera_auto_capture_due(now);
    bool force_due = force_capture.exchange(false);
    if (auto_due || force_due) {
      light_was_on_before_capture = get_relay(6);
      DiagnosticSerial.printf("[CAMERA] Triggering capture sequence (%s). Initial light state: %s. Turning light ON (Relay 6), 3s warmup...\n",
                    force_due ? "on-demand" : "scheduled",
                    light_was_on_before_capture ? "ALREADY ON" : "OFF");
      if (!light_was_on_before_capture) {
        set_relay(6, true);
      }
      warmup_start_ms = now;
      capture_state = CAM_STATE_WARMUP;
    }
    return;
  }

  if (capture_state == CAM_STATE_WARMUP) {
    // Merge any on-demand triggers that arrive during warmup
    if (force_capture.exchange(false)) {
      DiagnosticSerial.println("[CAMERA] Additional capture trigger merged (warmup already active)");
    }

    // Non-blocking wait for 3000ms
    if (now - warmup_start_ms < LIGHT_WARMUP_MS) {
      return; // Yield back to main loop to process MQTT, sensors, safety failsafes
    }

    // 3 seconds elapsed: capture frame
    DiagnosticSerial.println("[CAMERA] Light warmup complete (3s). Acquiring camera frame...");
    camera_fb_t *fb = esp_camera_fb_get();
    if (!fb) {
      DiagnosticSerial.println("[CAMERA WARN] Frame acquisition returned NULL, retrying in 50ms...");
      delay(50);
      fb = esp_camera_fb_get();
    }

    // Restore light state: if light was already ON by schedule/stage/manual, leave it ON!
    // Only turn it OFF if it was turned ON exclusively for the camera shot.
    if (!light_was_on_before_capture) {
      set_relay(6, false);
      DiagnosticSerial.println("[CAMERA] Light OFF (Relay 6) - returned to previous OFF state.");
    } else {
      DiagnosticSerial.println("[CAMERA] Light kept ON (Relay 6) - growth stage / schedule active.");
    }
    capture_state = CAM_STATE_IDLE;

    if (!fb) {
      DiagnosticSerial.println("[CAMERA ERR] Frame capture returned NULL after retry!");
      return;
    }

    camera_capture_started(now);

    DiagnosticSerial.printf("[CAMERA] Captured JPEG: %u bytes (%ux%u). Uploading via HTTPS...\n",
                  (unsigned int)fb->len, (unsigned int)fb->width, (unsigned int)fb->height);

    if (fb->len > 1024 * 1024) {
      DiagnosticSerial.println("[CAMERA HTTPS] Frame exceeds 1 MiB limit");
      esp_camera_fb_return(fb);
      return;
    }
    upload_in_progress.store(true);
    if (xTaskCreate(upload_photo_task, "photo_https", 12288, fb, 1, nullptr) != pdPASS) {
      esp_camera_fb_return(fb);
      upload_in_progress.store(false);
      DiagnosticSerial.println("[CAMERA HTTPS] Could not start upload task");
    }
  }
}
