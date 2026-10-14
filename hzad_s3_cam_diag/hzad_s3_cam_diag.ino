#include <Arduino.h>
#include "esp_chip_info.h"
#include "esp_system.h"
#include "config.h"
#include "bme_diag.h"
#include "camera_diag.h"

// =========================================================================
// Global Test State
// =========================================================================
static unsigned long last_bme_read_ms = 0;
static unsigned long last_cam_capture_ms = 0;
static uint32_t consecutive_capture_count = 0;
static bool ten_shots_completed = false;

// =========================================================================
// Stage A: Hardware Platform & Telemetry Diagnostics
// =========================================================================
void print_platform_info() {
  Serial.println("\n=======================================================");
  Serial.println("  " FIRMWARE_NAME);
  Serial.println("  Firmware Version: " FIRMWARE_VERSION);
  Serial.println("=======================================================");

  esp_chip_info_t chip_info;
  esp_chip_info(&chip_info);

  Serial.println("[PLATFORM] --- MCU & Silicon Diagnostics ---");
  Serial.print("[PLATFORM] Model:              ");
  if (chip_info.model == CHIP_ESP32S3) {
    Serial.println("ESP32-S3");
  } else {
    Serial.printf("Unknown (%d)\n", chip_info.model);
  }

  Serial.printf("[PLATFORM] Silicon Revision:   v%d.%d\n", chip_info.revision / 100, chip_info.revision % 100);
  Serial.printf("[PLATFORM] CPU Cores:          %d\n", chip_info.cores);
  Serial.printf("[PLATFORM] CPU Frequency:      %u MHz\n", (unsigned int)ESP.getCpuFreqMHz());
  Serial.printf("[PLATFORM] ESP-IDF Version:    %s\n", esp_get_idf_version());
#ifdef ESP_ARDUINO_VERSION_MAJOR
  Serial.printf("[PLATFORM] Arduino-ESP32 Core: %d.%d.%d\n", 
                ESP_ARDUINO_VERSION_MAJOR, ESP_ARDUINO_VERSION_MINOR, ESP_ARDUINO_VERSION_PATCH);
#endif

  Serial.println("\n[PLATFORM] --- Flash & Memory Verification ---");
  uint32_t flash_bytes = ESP.getFlashChipSize();
  Serial.printf("[PLATFORM] Flash Chip Size:    %u bytes (%.2f MB)\n", flash_bytes, flash_bytes / (1024.0 * 1024.0));
  Serial.printf("[PLATFORM] Flash Chip Speed:   %u MHz\n", (unsigned int)(ESP.getFlashChipSpeed() / 1000000));
  Serial.printf("[PLATFORM] Flash Chip Mode:    %s\n", 
                (ESP.getFlashChipMode() == FM_QIO) ? "QIO (Quad)" :
                (ESP.getFlashChipMode() == FM_QOUT) ? "QOUT (Quad)" :
                (ESP.getFlashChipMode() == FM_DIO) ? "DIO (Dual)" :
                (ESP.getFlashChipMode() == FM_DOUT) ? "DOUT (Dual)" : "OPI / Other");

  bool psram_ok = psramFound();
  Serial.printf("[PLATFORM] PSRAM Detected:     %s\n", psram_ok ? "YES" : "NO");
  if (psram_ok) {
    uint32_t psram_size = ESP.getPsramSize();
    uint32_t free_psram = ESP.getFreePsram();
    Serial.printf("[PLATFORM] Total PSRAM:        %u bytes (%.2f MB)\n", psram_size, psram_size / (1024.0 * 1024.0));
    Serial.printf("[PLATFORM] Free PSRAM:         %u bytes (%.2f MB)\n", free_psram, free_psram / (1024.0 * 1024.0));
  } else {
    Serial.println("[PLATFORM WARN] PSRAM is NOT detected or disabled in compiler flags!");
    Serial.println("[PLATFORM WARN] Camera buffer allocation at high resolutions will fail without PSRAM.");
  }

  Serial.printf("[PLATFORM] Free Internal Heap: %u bytes (%.2f KB)\n", ESP.getFreeHeap(), ESP.getFreeHeap() / 1024.0);
  Serial.println("[PLATFORM NOTICE] Flash and PSRAM confirmed via firmware API calls.");
  Serial.println("=======================================================\n");
}

void print_stage_summary() {
  Serial.println("\n=======================================================");
  Serial.println("  STAGE INITIALIZATION SUMMARY");
  Serial.println("=======================================================");
  Serial.printf("  Camera Status: %s (%s)\n", 
                is_camera_ready() ? "INITIALIZED (OK)" : "FAILED / OFFLINE",
                get_detected_camera_model());
  Serial.printf("  BME280 Status: %s (Address: 0x%02X, Chip ID: 0x%02X)\n",
                is_bme280_ready() ? "INITIALIZED (OK)" : "FAILED / OFFLINE",
                get_bme280_address(), get_bme280_chip_id());
  Serial.println("=======================================================\n");
}

// =========================================================================
// Setup & Main Loop
// =========================================================================
void setup() {
  Serial.begin(SERIAL_BAUD_RATE);
  delay(1500); // Allow CH340 USB serial to settle

  // Stage A: System Telemetry
  print_platform_info();

  // Stage B: BME280 Verification
  init_bme280();

  // Stage C: Camera Verification
  init_camera();

  // Print summary of both subsystems
  print_stage_summary();

  Serial.println("\n[STAGE D] ===============================================");
  Serial.println("[STAGE D] Starting Concurrent Operation Test");
  Serial.println("[STAGE D] BME280 will be sampled every 5 seconds.");
  Serial.printf("[STAGE D] Camera will capture %d sequential test frames.\n", SEQUENTIAL_SNAP_TARGET);
  Serial.println("[STAGE D] Type 'snap' in Serial Monitor to capture on demand.");
  Serial.println("[STAGE D] Type 'bme' to read sensor on demand.");
  Serial.println("[STAGE D] Type 'scan' to re-run I2C scanner.");
  Serial.println("[STAGE D] Type 'info' to reprint platform telemetry.");
  Serial.println("[STAGE D] ===============================================\n");

  last_bme_read_ms = millis();
  last_cam_capture_ms = millis();
}

void loop() {
  unsigned long now = millis();

  // Non-blocking BME280 periodic read every 5 seconds (Stage D requirement)
  if (now - last_bme_read_ms >= BME280_READ_INTERVAL_MS) {
    last_bme_read_ms = now;
    read_bme280();
  }

  // Sequential camera test sequence: capture 10 test frames
  if (!ten_shots_completed && is_camera_ready()) {
    if (now - last_cam_capture_ms >= CAM_TEST_INTERVAL_MS) {
      last_cam_capture_ms = now;
      consecutive_capture_count++;
      capture_single_photo(consecutive_capture_count);

      if (consecutive_capture_count >= SEQUENTIAL_SNAP_TARGET) {
        ten_shots_completed = true;
        Serial.println("\n*******************************************************");
        Serial.printf("[STAGE D COMPLETE] Successfully captured %u consecutive frames!\n", consecutive_capture_count);
        Serial.println("[STAGE D COMPLETE] BME280 continues background polling every 5s.");
        Serial.println("*******************************************************\n");
      }
    }
  }

  // Interactive Serial Console for manual testing
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    cmd.trim();
    if (cmd.equalsIgnoreCase("snap")) {
      consecutive_capture_count++;
      Serial.printf("[MANUAL] Triggering manual snapshot #%u...\n", consecutive_capture_count);
      capture_single_photo(consecutive_capture_count);
    } else if (cmd.equalsIgnoreCase("bme")) {
      Serial.println("[MANUAL] Manual BME280 reading:");
      read_bme280();
    } else if (cmd.equalsIgnoreCase("scan")) {
      init_bme280();
    } else if (cmd.equalsIgnoreCase("info")) {
      print_platform_info();
    } else if (cmd.length() > 0) {
      Serial.printf("[CONSOLE] Unknown command: '%s'. Available: 'snap', 'bme', 'scan', 'info'\n", cmd.c_str());
    }
  }
}
