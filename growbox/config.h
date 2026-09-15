#ifndef CONFIG_H
#define CONFIG_H

// BME280 Pins (I2C)
#define PIN_SDA 6
#define PIN_SCL 7

// DS18B20 Pin (OneWire)
#define PIN_DS18B20 4

// MH-Z19B Pins (UART2)
#define PIN_MHZ19_RX 17
#define PIN_MHZ19_TX 16

// Relays
#define PIN_RELAY_1 1 // humidifier
#define PIN_RELAY_2 2 // heater
#define PIN_RELAY_3 3 // heater fan
#define PIN_RELAY_4 8 // fan 1
#define PIN_RELAY_5 9 // fan 2
#define PIN_RELAY_6 10 // backlight

// Intervals (ms)
#define SENSOR_INTERVAL 30000
#define STATUS_INTERVAL 30000
#define CAMERA_INTERVAL 600000

#define NUM_RELAYS 6
extern const int relay_pins[NUM_RELAYS];

#endif
