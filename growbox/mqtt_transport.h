#ifndef MQTT_TRANSPORT_H
#define MQTT_TRANSPORT_H

#include <Arduino.h>

/**
 * @brief Initialize MQTT transport (supports WSS, WS, SSL, TCP)
 * Runs NTP time synchronization if TLS is enabled with CA verification.
 */
void setup_mqtt();

/**
 * @brief Background keepalive and reconnect monitoring loop
 */
void mqtt_loop();

/**
 * @brief Check if MQTT client is currently connected to broker
 */
bool mqtt_is_connected();

/**
 * @brief Publish climate sensors telemetry to growbox/sensors
 */
void mqtt_publish_sensors();

/**
 * @brief Publish relay and diagnostic telemetry to growbox/status
 */
void mqtt_publish_status();

/**
 * @brief Publish captured camera image to growbox/image/raw
 * Handles large payloads (~51-60KB) without silent truncation.
 *
 * @param json_payload JSON string containing format, dimensions and base64 data
 */
void mqtt_publish_image(const char* json_payload);

#endif // MQTT_TRANSPORT_H
