#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include "wifi_config.h"
#include "config.h"
#include "relay.h"
#include "sensors.h"
#include "mqtt_transport.h"
#include "camera_capture.h"
#include "camera_settings.h"
#include "ota_update.h"

unsigned long last_sensor_time = 0;
unsigned long last_status_time = 0;

void logMsg(const String &msg) {
  Serial.println(msg);
}

bool setup_wifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);

  struct WifiNetwork {
    const char* ssid;
    const char* pass;
  };

  const WifiNetwork networks[] = {
#ifdef WIFI_SSID_1
    { WIFI_SSID_1, WIFI_PASSWORD_1 },
#endif
#ifdef WIFI_SSID_2
    { WIFI_SSID_2, WIFI_PASSWORD_2 },
#endif
#if !defined(WIFI_SSID_1) && defined(WIFI_SSID)
    { WIFI_SSID, WIFI_PASSWORD },
#endif
  };

  const size_t num_networks = sizeof(networks) / sizeof(networks[0]);

  for (size_t i = 0; i < num_networks; i++) {
    logMsg("[WIFI] Connecting to network " + String(i + 1) + "/" + String(num_networks) + " (" + String(networks[i].ssid) + ")...");
    WiFi.disconnect(true);
    delay(100);
    WiFi.begin(networks[i].ssid, networks[i].pass);

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 12000) {
      delay(500);
      Serial.print(".");
    }
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      logMsg("[WIFI OK] Connected to " + String(networks[i].ssid) +
             "! IP: " + WiFi.localIP().toString() +
             " RSSI: " + String(WiFi.RSSI()) + " dBm");
      return true;
    } else {
      logMsg("[WIFI] Could not connect to " + String(networks[i].ssid) + " (status: " + String(WiFi.status()) + ")");
    }
  }

  logMsg("[WIFI WARN] All configured networks failed! Will retry in background.");
  return false;
}

void setup() {
  // CRITICAL: Initialize relays to HIGH (OFF) immediately on power-on
  setup_relays();

  Serial.begin(115200);
  delay(1000);

  logMsg("\n========================================");
  logMsg("   GROWBOX S3 CAM FIRMWARE STARTING");
  logMsg("========================================");

  setup_ota();
  setup_sensors();
  setup_wifi();
  setup_camera_settings();
  setup_mqtt();
  setup_camera();

  logMsg("[SYSTEM] Setup complete, entering main loop\n");
}

void loop() {
  process_ota();
  process_camera_settings();
  static unsigned long last_wifi_retry = 0;
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    if (now - last_wifi_retry > 15000) {
      last_wifi_retry = now;
      logMsg("[WIFI] Reconnecting...");
      setup_wifi();
    }
  } else {
    mqtt_loop();
  }
  
  if (now - last_sensor_time > SENSOR_INTERVAL || last_sensor_time == 0) {
    read_sensors();
    if (WiFi.status() == WL_CONNECTED) {
      mqtt_publish_sensors();
    }
    last_sensor_time = now;
  }
  
  if (now - last_status_time > STATUS_INTERVAL || last_status_time == 0) {
    if (WiFi.status() == WL_CONNECTED) {
      mqtt_publish_status();
    }
    last_status_time = now;
  }
  
  static unsigned long last_safety_time = 0;
  if (now - last_safety_time > 2000) {
    check_safety_failsafes();
    last_safety_time = now;
  }

  process_camera();
}
