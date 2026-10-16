#include "camera_settings.h"
#include "camera_capture.h"
#include "camera_schedule.h"
#include "mqtt_transport.h"
#include "config.h"
#include <Preferences.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>

struct CameraConfig {
  bool auto_enabled;
  uint32_t interval_seconds;
  char request_id[37];
};
static CameraConfig active = {false, CAMERA_DEFAULT_INTERVAL_SECONDS, ""};
static portMUX_TYPE config_mux = portMUX_INITIALIZER_UNLOCKED;
static QueueHandle_t pending_config = nullptr;
static CameraSchedule schedule;
static bool synchronized_this_boot = false;
static bool persisted = false;

static bool valid_request_id(const char *id) {
  if (!id || strlen(id) != 36) return false;
  for (int i = 0; i < 36; ++i) {
    if (i == 8 || i == 13 || i == 18 || i == 23) { if (id[i] != '-') return false; }
    else if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return false;
  }
  return true;
}

static bool parse_config(const char *json, size_t length, CameraConfig &out) {
  if (!json || length > 512) return false;
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  StaticJsonDocument<512> doc;
#endif
  if (deserializeJson(doc, json, length)) return false;
  if (!doc["protocol"].is<int>() || doc["protocol"].as<int>() != 1 ||
      !doc["auto_enabled"].is<bool>() || !doc["interval_seconds"].is<uint32_t>() ||
      !doc["request_id"].is<const char *>()) return false;
  uint32_t seconds = doc["interval_seconds"].as<uint32_t>();
  const char *id = doc["request_id"].as<const char *>();
  if (seconds < 60 || seconds > 86400 || seconds % 60 != 0 || !valid_request_id(id)) return false;
  out.auto_enabled = doc["auto_enabled"].as<bool>();
  out.interval_seconds = seconds;
  memcpy(out.request_id, id, sizeof(out.request_id));
  return true;
}

static CameraConfig snapshot(bool *saved = nullptr) {
  portENTER_CRITICAL(&config_mux);
  CameraConfig result = active;
  if (saved) *saved = persisted;
  portEXIT_CRITICAL(&config_mux);
  return result;
}

static void activate(const CameraConfig &value, bool saved) {
  portENTER_CRITICAL(&config_mux);
  active = value;
  persisted = saved;
  portEXIT_CRITICAL(&config_mux);
  schedule.apply(value.auto_enabled, value.interval_seconds, millis());
}

static String serialize_config(const CameraConfig &value) {
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  StaticJsonDocument<256> doc;
#endif
  doc["protocol"] = 1;
  doc["auto_enabled"] = value.auto_enabled;
  doc["interval_seconds"] = value.interval_seconds;
  doc["request_id"] = value.request_id;
  String json;
  serializeJson(doc, json);
  return json;
}

void setup_camera_settings() {
  pending_config = xQueueCreate(1, sizeof(CameraConfig));
  Preferences prefs;
  if (prefs.begin("camera", true)) {
    String json = prefs.getString("config", "");
    prefs.end();
    CameraConfig loaded;
    if (parse_config(json.c_str(), json.length(), loaded)) activate(loaded, true);
  }
  // Even restored auto capture waits for this boot's retained server config.
  synchronized_this_boot = false;
  Serial.println("[CAMERA CONFIG] Ready; auto capture waits for server configuration");
}

bool queue_camera_settings(const char *json, size_t length) {
  CameraConfig next;
  return pending_config && parse_config(json, length, next) && xQueueOverwrite(pending_config, &next) == pdPASS;
}

void process_camera_settings() {
  CameraConfig next;
  if (!pending_config || xQueueReceive(pending_config, &next, 0) != pdPASS) return;
  bool saved;
  CameraConfig previous = snapshot(&saved);
  if (saved && strcmp(previous.request_id, next.request_id) == 0 &&
      previous.auto_enabled == next.auto_enabled && previous.interval_seconds == next.interval_seconds) {
    synchronized_this_boot = true;
    publish_camera_settings();
    return; // QoS duplicates/reconnects must not wear out flash or reset timing.
  }
  // Disable immediately, even if NVS subsequently fails. Never enable on a failed save.
  if (!next.auto_enabled) activate(next, false);
  String json = serialize_config(next);
  Preferences prefs;
  bool written = false;
  if (prefs.begin("camera", false)) {
    written = prefs.putString("config", json) == json.length();
    prefs.end();
  }
  if (written) {
    activate(next, true);
    synchronized_this_boot = true;
    Serial.printf("[CAMERA CONFIG] Applied: auto=%d interval=%u seconds\n", next.auto_enabled, (unsigned)next.interval_seconds);
  } else {
    Serial.println("[CAMERA CONFIG] NVS save failed; requested auto-enable not applied");
  }
  publish_camera_settings();
}

void fill_camera_settings(JsonObject object) {
  bool saved;
  CameraConfig value = snapshot(&saved);
  object["protocol"] = 1;
  object["auto_enabled"] = value.auto_enabled;
  object["interval_seconds"] = value.interval_seconds;
  object["request_id"] = String(value.request_id);
  object["persisted"] = saved;
  object["camera_ready"] = is_camera_available();
}

bool camera_auto_capture_due(uint32_t now) { return synchronized_this_boot && schedule.due(now); }
void camera_capture_started(uint32_t now) { schedule.captured(now); }
