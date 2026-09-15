#ifndef MQTT_CLIENT_H
#define MQTT_CLIENT_H

#include <Arduino.h>

void setup_mqtt();
void mqtt_loop();
void mqtt_publish_sensors();
void mqtt_publish_status();
void mqtt_publish_image(const char* base64_data);

#endif
