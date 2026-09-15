#include "sensors.h"
#include "config.h"
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// BME280
Adafruit_BME280 bme;
bool bme_ok = false;

// DS18B20
OneWire oneWire(PIN_DS18B20);
DallasTemperature ds18b20(&oneWire);

float current_air_temp = -999.0;
float current_humidity = -999.0;
float current_pressure = -999.0;
float current_substrate_temp = -999.0;
int current_co2_ppm = -999;

void setup_sensors() {
  Wire.begin(PIN_SDA, PIN_SCL);
  if (bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire)) {
    Serial.println("[SENSORS] BME280 initialized");
    bme_ok = true;
  } else {
    Serial.println("[SENSORS] BME280 not found (normal if disconnected)");
    bme_ok = false;
  }

  ds18b20.begin();

  // MH-Z19B on built-in Serial1
  Serial1.begin(9600, SERIAL_8N1, PIN_MHZ19_RX, PIN_MHZ19_TX);
}

int read_co2() {
  byte cmd[9] = {0xFF,0x01,0x86,0x00,0x00,0x00,0x00,0x00,0x79};
  byte response[9];
  
  // Clear buffer
  while(Serial1.available() > 0) {
    Serial1.read();
  }
  
  Serial1.write(cmd, 9);
  
  unsigned long timeout = millis() + 150;
  while(Serial1.available() < 9) {
    if (millis() > timeout) {
      return -999;
    }
    delay(5);
  }
  
  for(int i = 0; i < 9; i++) {
    response[i] = Serial1.read();
  }
  
  if (response[0] == 0xFF && response[1] == 0x86) {
    int high = response[2];
    int low = response[3];
    return (high * 256) + low;
  }
  return -999;
}

void read_sensors() {
  if (bme_ok) {
    current_air_temp = bme.readTemperature();
    current_humidity = bme.readHumidity();
    current_pressure = bme.readPressure() / 100.0F; // Convert Pa to hPa
  } else {
    current_air_temp = -999.0;
    current_humidity = -999.0;
    current_pressure = -999.0;
  }

  ds18b20.requestTemperatures();
  current_substrate_temp = ds18b20.getTempCByIndex(0);
  if (current_substrate_temp == DEVICE_DISCONNECTED_C) {
    current_substrate_temp = -999.0;
  }

  current_co2_ppm = read_co2();
  
  Serial.printf("Sensors: Air=%.2fC, Hum=%.2f%%, Pres=%.2fhPa, Sub=%.2fC, CO2=%dppm\n", 
                current_air_temp, current_humidity, current_pressure, current_substrate_temp, current_co2_ppm);
}
