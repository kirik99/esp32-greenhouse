#include "mqtt_transport.h"
#include "wifi_config.h"
#include "config.h"
#include "sensors.h"
#include "relay.h"
#include "camera_capture.h"

#include <WiFi.h>
#include <ArduinoJson.h>
#include <time.h>
#include "esp_mac.h"
#include "esp_crt_bundle.h"
#include <mqtt_client.h>

// Fallback configuration macros for backward compatibility
#ifndef USE_MQTT_WEBSOCKETS
#define USE_MQTT_WEBSOCKETS false
#endif

#ifndef USE_MQTT_TLS
  #ifdef USE_MQTTS
    #define USE_MQTT_TLS USE_MQTTS
  #else
    #define USE_MQTT_TLS false
  #endif
#endif

#ifndef MQTT_PATH
#define MQTT_PATH "/mqtt"
#endif

#ifndef MQTT_ALLOW_INSECURE_TLS
#define MQTT_ALLOW_INSECURE_TLS false
#endif

#ifndef MQTT_USER
#define MQTT_USER ""
#endif

#ifndef MQTT_PASS
#define MQTT_PASS ""
#endif

static esp_mqtt_client_handle_t mqtt_client = NULL;
static volatile bool is_connected = false;
static unsigned long last_disconnect_log = 0;
static char client_id_str[36] = {0};

static void init_client_id() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(client_id_str, sizeof(client_id_str), "GrowboxESP32_%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
}

static void sync_ntp_time() {
  Serial.println("[TIME] Synchronizing system time via NTP for TLS certificate validation...");
  configTime(0, 0, "pool.ntp.org", "time.google.com", "time.cloudflare.com");

  time_t now = time(nullptr);
  unsigned long start = millis();
  // Wait up to 10 seconds for NTP synchronization (> Jan 1 2024 = 1704067200)
  while (now < 1704067200 && millis() - start < 10000) {
    delay(400);
    Serial.print(".");
    now = time(nullptr);
  }
  Serial.println();

  if (now >= 1704067200) {
    struct tm timeinfo;
    gmtime_r(&now, &timeinfo);
    char buf[64];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S UTC", &timeinfo);
    Serial.printf("[TIME OK] Synchronized UTC time: %s (epoch: %ld)\n", buf, (long)now);
  } else {
    Serial.println("[TIME WARN] NTP sync timed out! TLS certificate validation may fail if RTC is uninitialized.");
  }
}

static void mqtt_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data) {
  esp_mqtt_event_handle_t event = (esp_mqtt_event_handle_t)event_data;
  esp_mqtt_client_handle_t client = event->client;

  switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED: {
      is_connected = true;
      Serial.println("[MQTT OK] Connected to broker!");

      // Resubscribe to all control topics on connection / reconnection
      int id1 = esp_mqtt_client_subscribe(client, "growbox/relay/set", 1);
      int id2 = esp_mqtt_client_subscribe(client, "growbox/camera/capture", 1);
      int id3 = esp_mqtt_client_subscribe(client, "growbox/co2/calibrate", 1);
      Serial.printf("[MQTT] Subscribed to control topics (IDs: %d, %d, %d)\n", id1, id2, id3);

      // Publish initial status report immediately
      mqtt_publish_status();
      break;
    }

    case MQTT_EVENT_DISCONNECTED: {
      is_connected = false;
      unsigned long now = millis();
      if (now - last_disconnect_log > 5000) {
        Serial.println("[MQTT] Disconnected from broker. Retrying in background...");
        last_disconnect_log = now;
      }
      break;
    }

    case MQTT_EVENT_SUBSCRIBED:
      Serial.printf("[MQTT] Topic subscription acknowledged (msg_id: %d)\n", event->msg_id);
      break;

    case MQTT_EVENT_UNSUBSCRIBED:
      Serial.printf("[MQTT] Topic unsubscription acknowledged (msg_id: %d)\n", event->msg_id);
      break;

    case MQTT_EVENT_DATA: {
      // Safely extract topic (non null-terminated string)
      char topic_buf[128] = {0};
      int topic_len = (event->topic_len < (int)sizeof(topic_buf) - 1) ? event->topic_len : sizeof(topic_buf) - 1;
      memcpy(topic_buf, event->topic, topic_len);
      topic_buf[topic_len] = '\0';

      // Safely extract payload
      int data_len = event->data_len;
      char* data_buf = (char*)malloc(data_len + 1);
      if (!data_buf) {
        Serial.println("[MQTT ERR] Out of memory allocating incoming payload buffer!");
        break;
      }
      memcpy(data_buf, event->data, data_len);
      data_buf[data_len] = '\0';

      Serial.printf("[MQTT MSG] Topic: %s (len: %d) -> %s\n", topic_buf, data_len, data_buf);

      if (strcmp(topic_buf, "growbox/relay/set") == 0) {
        #if ARDUINOJSON_VERSION_MAJOR >= 7
        JsonDocument doc;
        #else
        StaticJsonDocument<256> doc;
        #endif
        DeserializationError error = deserializeJson(doc, data_buf);
        if (!error) {
          if (!doc["relay"].isNull() && !doc["state"].isNull()) {
            int relay = doc["relay"];
            bool state = doc["state"];
            set_relay(relay, state);
            mqtt_publish_status();
          }
        } else {
          Serial.printf("[MQTT ERR] JSON parse error in relay/set: %s\n", error.c_str());
        }
      } else if (strcmp(topic_buf, "growbox/camera/capture") == 0) {
        Serial.println("[MQTT] Manual camera snapshot trigger received!");
        trigger_camera_capture();
      } else if (strcmp(topic_buf, "growbox/co2/calibrate") == 0) {
        Serial.println("[MQTT] CO2 Zero Calibration trigger received!");
        calibrate_co2_zero();
      }

      free(data_buf);
      break;
    }

    case MQTT_EVENT_ERROR: {
      Serial.println("[MQTT ERR] Transport or protocol error reported");
      if (event->error_handle) {
        if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
          Serial.printf("[MQTT ERR] Transport error details: esp_tls_last_esp_err=0x%x, esp_tls_stack_err=0x%x, sock_errno=%d\n",
                        event->error_handle->esp_tls_last_esp_err,
                        event->error_handle->esp_tls_stack_err,
                        event->error_handle->esp_transport_sock_errno);
        } else if (event->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
          Serial.printf("[MQTT ERR] Connection refused by broker, return code: %d\n",
                        event->error_handle->connect_return_code);
        }
      }
      break;
    }

    default:
      break;
  }
}

void setup_mqtt() {
  init_client_id();

  #if USE_MQTT_TLS && !MQTT_ALLOW_INSECURE_TLS
  // Ensure accurate RTC time for TLS certificate validity period verification
  sync_ntp_time();
  #endif

  esp_mqtt_transport_t transport;
  #if USE_MQTT_WEBSOCKETS
    #if USE_MQTT_TLS
      transport = MQTT_TRANSPORT_OVER_WSS;
    #else
      transport = MQTT_TRANSPORT_OVER_WS;
    #endif
  #else
    #if USE_MQTT_TLS
      transport = MQTT_TRANSPORT_OVER_SSL;
    #else
      transport = MQTT_TRANSPORT_OVER_TCP;
    #endif
  #endif

  esp_mqtt_client_config_t mqtt_cfg = {};
  mqtt_cfg.broker.address.hostname = MQTT_HOST;
  mqtt_cfg.broker.address.port = MQTT_PORT;
  mqtt_cfg.broker.address.transport = transport;

  #if USE_MQTT_WEBSOCKETS
  mqtt_cfg.broker.address.path = MQTT_PATH;
  #endif

  #if USE_MQTT_TLS
    #if MQTT_ALLOW_INSECURE_TLS
      Serial.println("[MQTT WARN] Insecure TLS mode: Certificate validation DISABLED!");
      mqtt_cfg.broker.verification.skip_cert_common_name_check = true;
    #else
      Serial.println("[MQTT] Strict TLS mode: Verifying server certificate using ESP CRT bundle.");
      mqtt_cfg.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
      mqtt_cfg.broker.verification.skip_cert_common_name_check = false;
    #endif
  #endif

  mqtt_cfg.credentials.client_id = client_id_str;

  if (strlen(MQTT_USER) > 0) {
    mqtt_cfg.credentials.username = MQTT_USER;
  }
  if (strlen(MQTT_PASS) > 0) {
    mqtt_cfg.credentials.authentication.password = MQTT_PASS;
  }

  mqtt_cfg.session.keepalive = 60;
  mqtt_cfg.session.disable_clean_session = false;

  mqtt_cfg.network.reconnect_timeout_ms = 5000;
  mqtt_cfg.network.timeout_ms = 15000;

  // Optimized buffers for handling large frames and camera messages
  mqtt_cfg.buffer.size = 4096;
  mqtt_cfg.buffer.out_size = 8192;
  mqtt_cfg.outbox.limit = 128 * 1024;

  // Background FreeRTOS task configuration
  mqtt_cfg.task.stack_size = 8192;
  mqtt_cfg.task.priority = 5;

  const char* proto = (transport == MQTT_TRANSPORT_OVER_WSS) ? "wss" :
                      (transport == MQTT_TRANSPORT_OVER_WS)  ? "ws" :
                      (transport == MQTT_TRANSPORT_OVER_SSL) ? "mqtts" : "mqtt";
  Serial.printf("[MQTT] Configuring %s://%s:%d%s (Client ID: %s)\n",
                proto, MQTT_HOST, (int)MQTT_PORT,
                USE_MQTT_WEBSOCKETS ? MQTT_PATH : "",
                client_id_str);

  mqtt_client = esp_mqtt_client_init(&mqtt_cfg);
  if (!mqtt_client) {
    Serial.println("[MQTT ERR] Failed to initialize esp-mqtt client!");
    return;
  }

  esp_mqtt_client_register_event(mqtt_client, MQTT_EVENT_ANY, mqtt_event_handler, NULL);
  esp_err_t err = esp_mqtt_client_start(mqtt_client);
  if (err != ESP_OK) {
    Serial.printf("[MQTT ERR] esp_mqtt_client_start failed: %d\n", err);
  } else {
    Serial.println("[MQTT OK] Client background service started.");
  }
}

void mqtt_loop() {
  // esp-mqtt processes events asynchronously in FreeRTOS mqtt_task.
  // We monitor connection state and trigger reconnect if Wi-Fi restored after drop.
  static bool was_wifi_connected = true;
  bool is_wifi = (WiFi.status() == WL_CONNECTED);

  if (!was_wifi_connected && is_wifi && mqtt_client) {
    Serial.println("[MQTT] Wi-Fi restored, triggering reconnect...");
    esp_mqtt_client_reconnect(mqtt_client);
  }
  was_wifi_connected = is_wifi;
}

bool mqtt_is_connected() {
  return is_connected && (WiFi.status() == WL_CONNECTED);
}

void mqtt_publish_sensors() {
  if (!is_connected || !mqtt_client) return;

  #if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
  #else
  StaticJsonDocument<512> doc;
  #endif

  time_t now_sec = time(nullptr);
  if (now_sec > 1704067200) {
    doc["timestamp"] = (long)now_sec;
  } else {
    doc["timestamp"] = millis() / 1000;
  }
  doc["air_temp"] = current_air_temp;
  doc["humidity"] = current_humidity;
  doc["pressure"] = current_pressure;
  doc["substrate_temp"] = current_substrate_temp;
  doc["co2_ppm"] = current_co2_ppm;

  char buffer[512];
  size_t len = serializeJson(doc, buffer);
  int msg_id = esp_mqtt_client_publish(mqtt_client, "growbox/sensors", buffer, len, 0, 0);
  if (msg_id < 0) {
    Serial.printf("[MQTT ERR] Failed to publish growbox/sensors (code: %d)\n", msg_id);
  }
}

void mqtt_publish_status() {
  if (!is_connected || !mqtt_client) return;

  #if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
  #else
  StaticJsonDocument<1024> doc;
  #endif

  for (int i = 1; i <= 6; i++) {
    doc["relays"].add(get_relay(i));
  }
  doc["uptime_s"] = millis() / 1000;
  doc["wifi_rssi"] = WiFi.RSSI();
  doc["free_heap"] = ESP.getFreeHeap();
  doc["alarm"] = current_alarm;
  doc["heater_locked"] = is_heater_locked();
  doc["diag"] = sensor_diag;

  char buffer[1024];
  size_t len = serializeJson(doc, buffer);
  int msg_id = esp_mqtt_client_publish(mqtt_client, "growbox/status", buffer, len, 0, 0);
  if (msg_id < 0) {
    Serial.printf("[MQTT ERR] Failed to publish growbox/status (code: %d)\n", msg_id);
  }
}

void mqtt_publish_image(const char* json_payload) {
  if (!is_connected || !mqtt_client) {
    Serial.println("[CAMERA ERR] Image publication aborted: MQTT not connected!");
    return;
  }

  size_t len = strlen(json_payload);
  Serial.printf("[CAMERA] Publishing image to growbox/image/raw (%u bytes)...\n", (unsigned int)len);

  int msg_id = esp_mqtt_client_publish(mqtt_client, "growbox/image/raw", json_payload, len, 0, 0);
  if (msg_id >= 0) {
    Serial.println("[CAMERA OK] Image successfully published to broker!");
  } else {
    Serial.printf("[CAMERA ERR] Image publication failed (%u bytes), esp-mqtt error code: %d\n",
                  (unsigned int)len, msg_id);
  }
}
