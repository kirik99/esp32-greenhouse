#ifndef WIFI_CONFIG_EXAMPLE_H
#define WIFI_CONFIG_EXAMPLE_H

#define WIFI_SSID     "your_wifi_name"
#define WIFI_PASSWORD "your_wifi_password"

// --- Remote Production Profile: MQTT over Secure WebSocket (WSS on port 443) ---
#define MQTT_HOST     "growbox.weird.cyou"
#define MQTT_PORT     443
#define MQTT_PATH     "/mqtt"
#define MQTT_USER     "growbox_esp32"
#define MQTT_PASS     "growbox_esp32_secret" // Must match MQTT_ESP32_PASSWORD in server/.env

#define USE_MQTT_WEBSOCKETS     true   // true = MQTT over WebSocket (WS/WSS)
#define USE_MQTT_TLS            true   // true = TLS encryption (WSS)
#define MQTT_ALLOW_INSECURE_TLS false  // false = strict CA certificate validation (Production)

// --- Local Development Profile: Plain MQTT over TCP (port 1883) ---
// Note: Even for local TCP connections, authentication is required (allow_anonymous false).
// Must match MQTT_ESP32_USER and MQTT_ESP32_PASSWORD from server/.env.
// #define MQTT_HOST               "192.168.1.118"
// #define MQTT_PORT               1883
// #define MQTT_PATH               "/mqtt"
// #define MQTT_USER               "growbox_esp32"
// #define MQTT_PASS               "growbox_esp32_secret"
// #define USE_MQTT_WEBSOCKETS     false
// #define USE_MQTT_TLS            false
// #define MQTT_ALLOW_INSECURE_TLS false

#endif
