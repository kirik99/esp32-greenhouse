#include "diagnostics.h"
#include "diagnostic_buffer.h"
#include "mqtt_transport.h"
#include "wifi_config.h"
#include <esp_random.h>

static DiagnosticBuffer buffer;
static portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
static char boot_id[9] = {};
static bool enabled = false;
DiagnosticSerialPort DiagnosticSerial;

static const char* const secrets[] = {
  "", // Keep the array valid even with an empty custom wifi_config.h.
#ifdef MQTT_PASS
  MQTT_PASS,
#endif
#ifdef IMAGE_UPLOAD_TOKEN
  IMAGE_UPLOAD_TOKEN,
#endif
#ifdef OTA_DOWNLOAD_TOKEN
  OTA_DOWNLOAD_TOKEN,
#endif
#ifdef WIFI_PASSWORD
  WIFI_PASSWORD,
#endif
#ifdef WIFI_PASSWORD_1
  WIFI_PASSWORD_1,
#endif
#ifdef WIFI_PASSWORD_2
  WIFI_PASSWORD_2,
#endif
#ifdef WIFI_SSID
  WIFI_SSID,
#endif
#ifdef WIFI_SSID_1
  WIFI_SSID_1,
#endif
#ifdef WIFI_SSID_2
  WIFI_SSID_2,
#endif
};

size_t DiagnosticSerialPort::write(uint8_t value) { return write(&value, 1); }
size_t DiagnosticSerialPort::write(const uint8_t* data, size_t size) {
  const size_t sent = Serial.write(data, size); // USB output remains unchanged.
  // Bounded work only; no MQTT calls, allocations or waiting for network here.
  const uint32_t now = millis();
  portENTER_CRITICAL(&mux);
  for (size_t i = 0; i < size; ++i) buffer.feed(static_cast<char>(data[i]), now, secrets, sizeof(secrets) / sizeof(secrets[0]));
  portEXIT_CRITICAL(&mux);
  return sent;
}

static void diagnostics_task(void*) {
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(500)); // At most two small non-retained packets per second.
    if (!mqtt_is_connected()) continue;
    DiagnosticEntry entry;
    uint32_t dropped;
    portENTER_CRITICAL(&mux);
    const bool have = buffer.pop(entry); dropped = buffer.dropped;
    portEXIT_CRITICAL(&mux);
    if (!have) continue;
    // Best effort only. Never recursively log the logger's own transport errors.
    if (!mqtt_enqueue_diagnostic(boot_id, entry.seq, entry.uptime_ms, dropped, diagnostic_level(entry.message), entry.message)) {
      portENTER_CRITICAL(&mux); ++buffer.dropped; portEXIT_CRITICAL(&mux);
    }
  }
}

void setup_diagnostics() {
  snprintf(boot_id, sizeof(boot_id), "%08lx", static_cast<unsigned long>(esp_random()));
  enabled = xTaskCreate(diagnostics_task, "diagnostics", 6144, nullptr, 1, nullptr) == pdPASS;
  if (!enabled) Serial.println("[LOG] Remote diagnostics task unavailable; USB serial still works");
}

void fill_diagnostics_status(JsonObject object) {
  uint32_t dropped; size_t queued;
  portENTER_CRITICAL(&mux); dropped = buffer.dropped; queued = buffer.count(); portEXIT_CRITICAL(&mux);
  object["protocol"] = 1; object["enabled"] = enabled; object["boot_id"] = boot_id;
  object["dropped"] = dropped; object["queued"] = queued;
}
