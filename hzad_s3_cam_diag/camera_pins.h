#ifndef CAMERA_PINS_H
#define CAMERA_PINS_H

// =========================================================================
// Camera Pin Definitions for ESP32-S3 DVP Ribbon (FPC/FFC)
// =========================================================================
// Status of pin mapping: UNCONFIRMED until verified on this physical board.
//
// Profile 1: ESP32S3_EYE / Freenove ESP32-S3 WROOM CAM (Standard for ~95% S3 CAMs)
// Profile 2: Freenove Alt Byte Order
// Profile 3: Seeed Studio XIAO ESP32-S3 Sense
// Profile 4: Waveshare ESP32-S3-CAM
// =========================================================================

#define CAM_PROFILE_S3_STANDARD 1
#define CAM_PROFILE_S3_FREENOVE 2
#define CAM_PROFILE_S3_XIAO     3
#define CAM_PROFILE_S3_WAVESHARE 4

// Selected profile for testing:
#define ACTIVE_CAM_PROFILE CAM_PROFILE_S3_STANDARD

#if (ACTIVE_CAM_PROFILE == CAM_PROFILE_S3_STANDARD)
  // Espressif ESP32-S3-EYE standard reference pinout for DVP camera
  #define CAM_PROFILE_NAME "ESP32-S3 Standard Reference (S3-EYE / AI-Thinker S3)"
  #define PWDN_GPIO_NUM  -1
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  15
  #define SIOD_GPIO_NUM  4
  #define SIOC_GPIO_NUM  5

  #define Y9_GPIO_NUM    16
  #define Y8_GPIO_NUM    17
  #define Y7_GPIO_NUM    18
  #define Y6_GPIO_NUM    12
  #define Y5_GPIO_NUM    10
  #define Y4_GPIO_NUM    8
  #define Y3_GPIO_NUM    9
  #define Y2_GPIO_NUM    11

  #define VSYNC_GPIO_NUM 6
  #define HREF_GPIO_NUM  7
  #define PCLK_GPIO_NUM  13

#elif (ACTIVE_CAM_PROFILE == CAM_PROFILE_S3_FREENOVE)
  #define CAM_PROFILE_NAME "Freenove ESP32-S3 WROOM CAM"
  #define PWDN_GPIO_NUM  -1
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  15
  #define SIOD_GPIO_NUM  4
  #define SIOC_GPIO_NUM  5

  #define Y9_GPIO_NUM    11
  #define Y8_GPIO_NUM    9
  #define Y7_GPIO_NUM    8
  #define Y6_GPIO_NUM    10
  #define Y5_GPIO_NUM    12
  #define Y4_GPIO_NUM    18
  #define Y3_GPIO_NUM    17
  #define Y2_GPIO_NUM    16

  #define VSYNC_GPIO_NUM 6
  #define HREF_GPIO_NUM  7
  #define PCLK_GPIO_NUM  13

#elif (ACTIVE_CAM_PROFILE == CAM_PROFILE_S3_XIAO)
  #define CAM_PROFILE_NAME "XIAO ESP32-S3 Sense"
  #define PWDN_GPIO_NUM  -1
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  10
  #define SIOD_GPIO_NUM  40
  #define SIOC_GPIO_NUM  39

  #define Y9_GPIO_NUM    48
  #define Y8_GPIO_NUM    11
  #define Y7_GPIO_NUM    12
  #define Y6_GPIO_NUM    14
  #define Y5_GPIO_NUM    16
  #define Y4_GPIO_NUM    18
  #define Y3_GPIO_NUM    17
  #define Y2_GPIO_NUM    15

  #define VSYNC_GPIO_NUM 38
  #define HREF_GPIO_NUM  47
  #define PCLK_GPIO_NUM  13

#elif (ACTIVE_CAM_PROFILE == CAM_PROFILE_S3_WAVESHARE)
  #define CAM_PROFILE_NAME "Waveshare ESP32-S3 CAM"
  #define PWDN_GPIO_NUM  -1
  #define RESET_GPIO_NUM -1
  #define XCLK_GPIO_NUM  3
  #define SIOD_GPIO_NUM  48
  #define SIOC_GPIO_NUM  47

  #define Y9_GPIO_NUM    41
  #define Y8_GPIO_NUM    45
  #define Y7_GPIO_NUM    46
  #define Y6_GPIO_NUM    42
  #define Y5_GPIO_NUM    40
  #define Y4_GPIO_NUM    38
  #define Y3_GPIO_NUM    15
  #define Y2_GPIO_NUM    18

  #define VSYNC_GPIO_NUM 1
  #define HREF_GPIO_NUM  2
  #define PCLK_GPIO_NUM  39
#endif

#endif // CAMERA_PINS_H
