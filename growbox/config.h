#ifndef CONFIG_H
#define CONFIG_H

// BME280 Pins (I2C on STEMMA QT connector: SDA=16, SCL=17)
#define PIN_SDA 16
#define PIN_SCL 17

// DS18B20 Pin (OneWire on A0 / GPIO 12, with 4.7k pullup to 3.3V)
#define PIN_DS18B20 12

// MH-Z19B Pins (Hardware UART: ESP32 RX=8 from Sensor TX, ESP32 TX=18 to Sensor RX)
#define PIN_MHZ19_RX 8
#define PIN_MHZ19_TX 18

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
