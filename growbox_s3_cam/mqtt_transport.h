#ifndef MQTT_TRANSPORT_H
#define MQTT_TRANSPORT_H

#include <Arduino.h>
#include <esp_arduino_version.h>

// Enforce Arduino-ESP32 Core 3.x (ESP-IDF 5.x) at compile-time
#if !defined(ESP_ARDUINO_VERSION_MAJOR) || (ESP_ARDUINO_VERSION_MAJOR < 3)
#error "CRITICAL: This firmware requires Arduino-ESP32 Core version 3.x (ESP-IDF 5.x) or newer! Please update the 'esp32' board package in Arduino IDE Boards Manager to 3.2.1+."
#endif

// Lifecycle
void setup_mqtt();
void mqtt_loop();
bool mqtt_is_connected();
bool mqtt_enqueue_diagnostic(const char* boot_id, uint32_t seq, uint32_t uptime_ms,
                             uint32_t dropped, const char* level, const char* message);

// Telemetry & Status Publishing
void mqtt_publish_sensors();
void mqtt_publish_status();
void publish_camera_settings();

// Camera Publishing (Executed from background FreeRTOS task on Core 0)
void mqtt_publish_image(const char* json_payload);

#endif // MQTT_TRANSPORT_H
