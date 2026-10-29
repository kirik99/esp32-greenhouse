#pragma once
#include <Arduino.h>
#include <ArduinoJson.h>

void setup_camera_settings();
bool queue_camera_settings(const char *json, size_t length);
void process_camera_settings();
void fill_camera_settings(JsonObject object);
void publish_camera_settings();
bool camera_auto_capture_due(uint32_t now);
void camera_capture_started(uint32_t now);
