#ifndef CAMERA_DIAG_H
#define CAMERA_DIAG_H

#include <Arduino.h>

bool init_camera();
bool capture_single_photo(uint32_t shot_number);
bool is_camera_ready();
const char* get_detected_camera_model();

#endif // CAMERA_DIAG_H
