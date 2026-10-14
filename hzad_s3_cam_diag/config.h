#ifndef DIAG_CONFIG_H
#define DIAG_CONFIG_H

#include <Arduino.h>

// =========================================================================
// Firmware & Hardware Identification
// =========================================================================
#define FIRMWARE_NAME       "HZAD ESP32-S3 WROOM N16R8 CAM Diagnostic"
#define FIRMWARE_VERSION    "1.0.0-stage1"

// =========================================================================
// I2C Pin Configuration for BME280
// =========================================================================
// STATUS: UNCONFIRMED
// Note: On ESP32-S3 CAM boards, GPIO 16 and 17 are normally routed to the
// camera parallel DVP interface (Y8/Y9 or Y2/Y3).
// If physically wired to 16 and 17, set them here.
// Common breakout header pins free from camera conflicts are GPIO 1 (SDA) and GPIO 2 (SCL).
#define UNCONFIRMED_I2C_SDA     16  // [UNCONFIRMED] candidate SDA pin
#define UNCONFIRMED_I2C_SCL     17  // [UNCONFIRMED] candidate SCL pin

// Target I2C addresses for BME280
#define BME280_PRIMARY_ADDR     0x76
#define BME280_SECONDARY_ADDR   0x77
#define BME280_CHIP_ID          0x60
#define BMP280_CHIP_ID          0x58

// =========================================================================
// Timing & Intervals
// =========================================================================
#define SERIAL_BAUD_RATE        115200
#define BME280_READ_INTERVAL_MS 5000     // 5 seconds as specified in Stage B & D
#define CAM_TEST_INTERVAL_MS    10000    // Automatic snapshot interval for test sequence
#define SEQUENTIAL_SNAP_TARGET  10       // Minimum 10 consecutive captures for Stage D

#endif // DIAG_CONFIG_H
