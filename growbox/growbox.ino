#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Adafruit_BME280.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include "USB_STREAM.h"
#include "wifi_config.h"
#include "config.h"
#include "relay.h"
#include "sensors.h"
#include "mqtt_client.h"
#include "camera_capture.h"

unsigned long last_sensor_time = 0;
unsigned long last_status_time = 0;

void logMsg(const String &msg) {
  Serial.println(msg);
  Serial0.println(msg);
  printf("%s\n", msg.c_str());
  fflush(stdout);
}

bool setup_wifi() {
  logMsg("[WIFI] Connecting to " + String(WIFI_SSID) + "...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(500);
    Serial.print(".");
    Serial0.print(".");
  }
  Serial.println();
  Serial0.println();

  if (WiFi.status() == WL_CONNECTED) {
    logMsg("[WIFI OK] Connected! IP: " + WiFi.localIP().toString() + " RSSI: " + String(WiFi.RSSI()) + " dBm");
    return true;
  } else {
    logMsg("[WIFI WARN] Connection timed out! Will retry in background.");
    return false;
  }
}

void setup() {
  Serial.begin(115200);
  Serial0.begin(115200);
  delay(1500);

  logMsg("\n========================================");
  logMsg("        GROWBOX FIRMWARE STARTING");
  logMsg("========================================");

  setup_relays();
  setup_sensors();
  setup_wifi();
  setup_mqtt();
  setup_camera();

  logMsg("[SYSTEM] Setup complete, entering main loop\n");
}

void loop() {
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
  
  if (now - last_sensor_time > SENSOR_INTERVAL) {
    read_sensors();
    if (WiFi.status() == WL_CONNECTED) {
      mqtt_publish_sensors();
    }
    last_sensor_time = now;
  }
  
  if (now - last_status_time > STATUS_INTERVAL) {
    if (WiFi.status() == WL_CONNECTED) {
      mqtt_publish_status();
    }
    last_status_time = now;
  }
  
  process_camera();
}
