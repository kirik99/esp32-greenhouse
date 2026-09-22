#ifndef CONFIG_H
#define CONFIG_H

// BME280 Pins (I2C on STEMMA QT connector: SDA=16, SCL=17)
#define PIN_SDA 16
#define PIN_SCL 17

// Legacy I2C pins: early revisions of this project wired the BME280 to GPIO 6/7
// (they are the UP/DOWN buttons on the MatrixPortal S3). If no device answers on
// the STEMMA QT bus above, the firmware retries the scan on this pair so an old
// harness keeps working instead of reporting "BME:none".
#define I2C_FALLBACK_ENABLED 1
#define PIN_I2C_FALLBACK_SDA 6
#define PIN_I2C_FALLBACK_SCL 7

// DS18B20 Pin (OneWire on A0 / GPIO 12, with 4.7k pullup to 3.3V)
#define PIN_DS18B20 12

// MH-Z19B Pins (Hardware UART: ESP32 RX=8 from Sensor TX, ESP32 TX=18 to Sensor RX)
// NOTE: the sensor VIN MUST be 5V (4.5-5.5V). On 3.3V the IR lamp never starts and
// the sensor stays completely silent on UART -> telemetry shows CO2: no_reply.
#define PIN_MHZ19_RX 8
#define PIN_MHZ19_TX 18
#define MHZ19_BAUD 9600
#define MHZ19_RESPONSE_TIMEOUT_MS 500  // MH-Z19B answers in <150 ms; 500 ms covers warm-up hiccups
#define MHZ19_MAX_RETRIES 1            // extra attempts per measurement cycle (bounded loop stall)
#define MHZ19_WARMUP_MS 5000           // do not talk to the sensor before it has booted

// 6 Relays (LOW-active)
#define PIN_RELAY_1 3   // Pin A1: Увлажнитель
#define PIN_RELAY_2 9   // Pin A2: Нагреватель
#define PIN_RELAY_3 10  // Pin A3: Вентилятор нагревателя
#define PIN_RELAY_4 11  // Pin A4: Вентилятор 1 (приток/циркуляция)
#define PIN_RELAY_5 2   // HUB75 CLK (Pin 13): Вентилятор 2 (вытяжка)
#define PIN_RELAY_6 14  // HUB75 OE (Pin 15): Фитоподсветка

// Intervals (ms)
#define SENSOR_INTERVAL 30000
#define STATUS_INTERVAL 30000
#define CAMERA_INTERVAL 600000

// Frozen-reading detection ("values stop changing but look plausible").
// BME280: three byte-identical T/H/P readings in a row can only mean the chip is
// not performing new conversions (fake module, stuck controller, failed writes).
#define BME_STALE_CYCLES 3
// MH-Z19B: unchanged ppm is only a warning (a sealed box can really hold a level),
// the 5000 ppm value is the sensor's own preheat/fault marker.
#define CO2_STALE_CYCLES 3
#define CO2_SUSPICIOUS_PPM 5000

// Safety & Emergency Failsafe Thresholds
#define EMERGENCY_TEMP_AIR_MAX  50.0  // Emergency overheat cutoff (°C)
#define EMERGENCY_TEMP_SUB_MAX  32.0  // Max safe substrate temp for oyster mycelium (°C)
#define EMERGENCY_HUMIDITY_MAX  98.0  // Anti-flooding cutoff (%)
#define SAFE_TEMP_RESTORE       35.0  // Temp below which heater lock can be cleared (°C)

// MQTTS (TLS/SSL)
#ifndef USE_MQTTS
#define USE_MQTTS false
#endif
#define MQTTS_PORT 8883

#define NUM_RELAYS 6
extern const int relay_pins[NUM_RELAYS];

#endif
