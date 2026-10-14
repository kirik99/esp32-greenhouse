#pragma once
#define WIFI_SSID_1 "your_wifi"
#define WIFI_PASSWORD_1 "your_password"
#define MQTT_HOST "growbox.weird.cyou"
#define MQTT_PORT 443
#define MQTT_PATH "/mqtt"
#define MQTT_USER "growbox_esp32"
#define MQTT_PASS "replace_with_MQTT_ESP32_PASSWORD"
#define USE_MQTT_WEBSOCKETS true
#define USE_MQTT_TLS true
#define MQTT_ALLOW_INSECURE_TLS false
// Separate secret; must match IMAGE_UPLOAD_TOKEN in server/.env (32+ characters).
#define IMAGE_UPLOAD_URL "https://growbox.weird.cyou/api/upload-image"
#define IMAGE_UPLOAD_TOKEN ""
