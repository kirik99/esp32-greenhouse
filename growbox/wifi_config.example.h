#ifndef WIFI_CONFIG_EXAMPLE_H
#define WIFI_CONFIG_EXAMPLE_H

#define WIFI_SSID     "your_wifi_name"
#define WIFI_PASSWORD "your_wifi_password"

// --- Remote Production Profile: MQTT over Secure WebSocket (WSS on port 443) ---
#define MQTT_HOST     "growbox.weird.cyou"
#define MQTT_PORT     443
#define MQTT_PATH     "/mqtt"
#define MQTT_USER     "your_mqtt_username"
#define MQTT_PASS     "your_mqtt_password"

#define USE_MQTT_WEBSOCKETS     true   // true = MQTT over WebSocket (WS/WSS)
#define USE_MQTT_TLS            true   // true = TLS encryption (WSS)
#define MQTT_ALLOW_INSECURE_TLS false  // false = strict CA certificate validation (Production)

// --- Local Development Profile: Plain MQTT over TCP (port 1883) ---
// For local LAN testing without TLS/WebSockets, uncomment below:
// #define MQTT_HOST               "192.168.1.118"
// #define MQTT_PORT               1883
// #define MQTT_PATH               "/mqtt"
// #define MQTT_USER               ""
// #define MQTT_PASS               ""
// #define USE_MQTT_WEBSOCKETS     false
// #define USE_MQTT_TLS            false
// #define MQTT_ALLOW_INSECURE_TLS false

#endif
