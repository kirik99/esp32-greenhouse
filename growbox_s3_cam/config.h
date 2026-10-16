#ifndef CONFIG_H
#define CONFIG_H

// =========================================================================
// HZAD ESP32-S3 WROOM N16R8 CAM Pinout & Hardware Configuration
// =========================================================================

// --- 1. I2C Sensors (BME280) ---
// Confirmed on physical device: SDA=GPIO 1, SCL=GPIO 2
#define PIN_SDA 1
#define PIN_SCL 2

#define I2C_FALLBACK_ENABLED 0

// --- 2. Substrate Temperature Sensor (DS18B20 OneWire) ---
// Assigned to free breakout header GPIO 41 (4.7k pullup to 3.3V)
#define PIN_DS18B20 41

// --- 3. CO2 Sensor (MH-Z19B Hardware UART) ---
// Assigned to free breakout header GPIOs: ESP32 RX=39, TX=40
#define PIN_MHZ19_RX 39
#define PIN_MHZ19_TX 40
#define MHZ19_BAUD 9600
#define MHZ19_RESPONSE_TIMEOUT_MS 500
#define MHZ19_MAX_RETRIES 1
#define MHZ19_WARMUP_MS 5000

// --- 4. 6 Relays (LOW-active) ---
// Assigned to free general-purpose header GPIOs (non-conflicting with DVP camera):
#define PIN_RELAY_1 42  // Relay 1: Увлажнитель
#define PIN_RELAY_2 47  // Relay 2: Нагреватель
#define PIN_RELAY_3 48  // Relay 3: Вентилятор нагревателя
#define PIN_RELAY_4 21  // Relay 4: Вентилятор 1 (приток/циркуляция)
#define PIN_RELAY_5 14  // Relay 5: Вентилятор 2 (вытяжка)
#define PIN_RELAY_6 3   // Relay 6: Фитоподсветка

// --- 5. DVP Camera Pins (OV2640 on FPC/FFC Ribbon Cable) ---
// Verified & confirmed on physical device:
#define CAM_PIN_PWDN    -1
#define CAM_PIN_RESET   -1
#define CAM_PIN_XCLK    15
#define CAM_PIN_SIOD    4
#define CAM_PIN_SIOC    5
#define CAM_PIN_Y9      16
#define CAM_PIN_Y8      17
#define CAM_PIN_Y7      18
#define CAM_PIN_Y6      12
#define CAM_PIN_Y5      10
#define CAM_PIN_Y4      8
#define CAM_PIN_Y3      9
#define CAM_PIN_Y2      11
#define CAM_PIN_VSYNC   6
#define CAM_PIN_HREF    7
#define CAM_PIN_PCLK    13

// --- 6. Intervals (ms) ---
#define SENSOR_INTERVAL 10000   // 10s for responsive local monitoring
#define STATUS_INTERVAL 10000   // 10s
#define CAMERA_DEFAULT_INTERVAL_SECONDS 600 // Server-controlled; auto capture defaults OFF.

// Frozen-reading detection
#define BME_STALE_CYCLES 3
#define CO2_STALE_CYCLES 3
#define CO2_SUSPICIOUS_PPM 5000

// Safety & Emergency Failsafe Thresholds
#define EMERGENCY_TEMP_AIR_MAX  50.0  // Emergency overheat cutoff (°C)
#define EMERGENCY_TEMP_SUB_MAX  32.0  // Max safe substrate temp (°C)
#define EMERGENCY_HUMIDITY_MAX  98.0  // Anti-flooding cutoff (%)
#define SAFE_TEMP_RESTORE       35.0  // Safe temp restore (°C)

// MQTTS / TLS flags
#ifndef USE_MQTTS
#define USE_MQTTS false
#endif

#define NUM_RELAYS 6
extern const int relay_pins[NUM_RELAYS];

#endif // CONFIG_H
