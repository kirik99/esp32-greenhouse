#include "mqtt_client.h"
#include "wifi_config.h"
#include "sensors.h"
#include "relay.h"
#include "camera_capture.h"
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

WiFiClient espClient;
PubSubClient client(espClient);

unsigned long lastReconnectAttempt = 0;

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] ");
  
  String msg = "";
  for (unsigned int i = 0; i < length; i++) {
    msg += (char)payload[i];
  }
  Serial.println(msg);

  if (String(topic) == "growbox/relay/set") {
#if ARDUINOJSON_VERSION_MAJOR >= 7
    JsonDocument doc;
#else
    StaticJsonDocument<256> doc;
#endif
    DeserializationError error = deserializeJson(doc, msg);
    if (!error) {
      if (!doc["relay"].isNull() && !doc["state"].isNull()) {
        int relay = doc["relay"];
        bool state = doc["state"];
        set_relay(relay, state);
        mqtt_publish_status(); // push update immediately
      }
    }
  } else if (String(topic) == "growbox/camera/capture") {
    Serial.println("[MQTT] Manual camera snapshot trigger received!");
    trigger_camera_capture();
  }
}

boolean reconnect() {
  if (client.connect("GrowboxESP32", MQTT_USER, MQTT_PASS)) {
    Serial.println("MQTT connected");
    client.subscribe("growbox/relay/set");
    client.subscribe("growbox/camera/capture");
  }
  return client.connected();
}

void setup_mqtt() {
  client.setServer(MQTT_HOST, MQTT_PORT);
  client.setCallback(callback);
  // Increase buffer size to handle base64 image (160x120 YUY2 base64 is ~51KB)
  client.setBufferSize(60000); 
}

void mqtt_loop() {
  if (!client.connected()) {
    long now = millis();
    if (now - lastReconnectAttempt > 5000) {
      lastReconnectAttempt = now;
      if (reconnect()) {
        lastReconnectAttempt = 0;
      }
    }
  } else {
    client.loop();
  }
}

void mqtt_publish_sensors() {
  if (!client.connected()) return;
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  StaticJsonDocument<512> doc;
#endif
  
  doc["timestamp"] = millis() / 1000; // placeholder, or use NTP
  doc["air_temp"] = current_air_temp;
  doc["humidity"] = current_humidity;
  doc["pressure"] = current_pressure;
  doc["substrate_temp"] = current_substrate_temp;
  doc["co2_ppm"] = current_co2_ppm;

  char buffer[512];
  serializeJson(doc, buffer);
  client.publish("growbox/sensors", buffer);
}

void mqtt_publish_status() {
  if (!client.connected()) return;
  
#if ARDUINOJSON_VERSION_MAJOR >= 7
  JsonDocument doc;
#else
  StaticJsonDocument<512> doc;
#endif
  
  for (int i = 1; i <= 6; i++) {
    doc["relays"].add(get_relay(i));
  }
  
  doc["uptime_s"] = millis() / 1000;
  doc["wifi_rssi"] = WiFi.RSSI();
  doc["free_heap"] = ESP.getFreeHeap();

  char buffer[512];
  serializeJson(doc, buffer);
  client.publish("growbox/status", buffer);
}

void mqtt_publish_image(const char* json_payload) {
  if (!client.connected()) return;
  // Make sure MQTT_MAX_PACKET_SIZE or setBufferSize is large enough
  bool res = client.publish("growbox/image/raw", json_payload);
  Serial.printf("Image publish result: %d\n", res);
}
