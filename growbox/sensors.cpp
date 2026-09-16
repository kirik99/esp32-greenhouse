#include "sensors.h"
#include "config.h"
#include "relay.h"
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
String current_alarm = "NONE";

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

  check_safety_failsafes();
}

void check_safety_failsafes() {
  // 1. Overheat safety cutoff (Air temp >= 50°C or Substrate temp >= 32°C)
  bool air_overheat = (current_air_temp != -999.0 && current_air_temp >= EMERGENCY_TEMP_AIR_MAX);
  bool sub_overheat = (current_substrate_temp != -999.0 && current_substrate_temp >= EMERGENCY_TEMP_SUB_MAX);

  if (air_overheat || sub_overheat) {
    if (current_alarm != "OVERHEAT_EMERGENCY") {
      current_alarm = "OVERHEAT_EMERGENCY";
      emergency_cutoff(air_overheat ? "Air Temperature >= 50C!" : "Substrate Temperature >= 32C!");
    }
  } else if (is_heater_locked()) {
    // Cooled down below safe restore threshold: release safety lock
    bool air_safe = (current_air_temp == -999.0 || current_air_temp < SAFE_TEMP_RESTORE);
    bool sub_safe = (current_substrate_temp == -999.0 || current_substrate_temp < SAFE_TEMP_RESTORE);
    if (air_safe && sub_safe) {
      lock_heater(false);
      if (current_alarm == "OVERHEAT_EMERGENCY") {
        current_alarm = "NONE";
      }
    }
  }

  // 2. Extreme Overhumidity cutoff (>= 98%)
  if (current_humidity != -999.0 && current_humidity >= EMERGENCY_HUMIDITY_MAX) {
    if (get_relay(1)) { // Humidifier is ON
      set_relay(1, false);
      Serial.println("[SAFETY ALERT] Humidifier cut OFF: Humidity >= 98%!");
    }
    if (current_alarm == "NONE") {
      current_alarm = "OVERHUMIDITY_CUTOFF";
    }
  } else if (current_alarm == "OVERHUMIDITY_CUTOFF") {
    current_alarm = "NONE";
  }

  // 3. Sensor disconnected / wire break protection
  // If air temperature sensor failed, prevent heater from running blindly
  if (current_air_temp < -100.0 && current_substrate_temp < -100.0) {
    if (get_relay(2)) { // Heater is ON
      set_relay(2, false);
      Serial.println("[SAFETY ALERT] Heater cut OFF: Temperature sensors disconnected (-999)!");
    }
    if (current_alarm == "NONE") {
      current_alarm = "SENSOR_DISCONNECTED";
    }
  } else if (current_alarm == "SENSOR_DISCONNECTED") {
    current_alarm = "NONE";
  }
}

