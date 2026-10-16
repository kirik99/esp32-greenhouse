#pragma once
#include <ArduinoJson.h>
#include <stddef.h>
void setup_ota();
void process_ota();
bool queue_ota(const char *json, size_t length);
bool ota_busy();
void fill_ota_status(JsonObject object);
