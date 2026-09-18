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
String sensor_diag = "Init";

static int current_ds_pin = PIN_DS18B20;

int autodetect_ds18b20() {
  const int candidate_pins[] = {PIN_DS18B20, 5, 13, 6, 7};
  for (int p : candidate_pins) {
    pinMode(p, INPUT_PULLUP);
    gpio_pullup_en((gpio_num_t)p);
    OneWire testOw(p);
    if (testOw.reset() == 1) {
      Serial.printf("[SENSORS] DS18B20 detected on GPIO %d!\n", p);
      return p;
    }
  }
  return PIN_DS18B20;
}

String scan_i2c_bus() {
  String found = "";
  const uint8_t probe_addrs[] = {0x76, 0x77, 0x38, 0x40, 0x44, 0x19};
  for (uint8_t addr : probe_addrs) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission(true) == 0) {
      if (found.length() > 0) found += ",";
      found += "0x" + String(addr, HEX);
    }
  }
  return found.length() > 0 ? found : "none";
}

void setup_sensors() {
  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);
  Wire.setTimeOut(25);
  delay(50);

  if (bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire)) {
    Serial.println("[SENSORS] BME280 initialized on GPIO 16/17");
    bme_ok = true;
  } else {
    Serial.printf("[SENSORS] BME280 not found on 16/17. I2C bus devices: %s\n", scan_i2c_bus().c_str());
    bme_ok = false;
  }

  current_ds_pin = autodetect_ds18b20();
  pinMode(current_ds_pin, INPUT_PULLUP);
  gpio_pullup_en((gpio_num_t)current_ds_pin);
  oneWire.begin(current_ds_pin);
  ds18b20.setOneWire(&oneWire);
  ds18b20.begin();

  // MH-Z19B on built-in Serial1
  Serial1.begin(9600, SERIAL_8N1, PIN_MHZ19_RX, PIN_MHZ19_TX);
  delay(50);

  // Disable MH-Z19B Auto Baseline Calibration (ABC) to prevent false baseline drift in high-CO2 growbox
  byte disable_abc[9] = {0xFF, 0x01, 0x79, 0x00, 0x00, 0x00, 0x00, 0x00, 0x86};
  Serial1.write(disable_abc, 9);
  Serial1.flush();
  Serial.println("[SENSORS] MH-Z19B ABC (Auto-Calibration) disabled for mushroom cultivation.");
}

void calibrate_co2_zero() {
  // Winsen MH-Z19B Zero-point calibration command (sets current air to 400 ppm baseline)
  byte zero_cmd[9] = {0xFF, 0x01, 0x87, 0x00, 0x00, 0x00, 0x00, 0x00, 0x78};
  Serial1.write(zero_cmd, 9);
  Serial1.flush();
  Serial.println("[CO2] Zero-point calibration command sent (400 ppm baseline)!");
}

int read_co2() {
  byte cmd[9] = {0xFF,0x01,0x86,0x00,0x00,0x00,0x00,0x00,0x79};
  byte response[9];
  
  while(Serial1.available() > 0) {
    Serial1.read();
  }
  
  Serial1.write(cmd, 9);
  Serial1.flush();
  
  unsigned long timeout = millis() + 300;
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
  String diag = "";

  // 1. BME280
  if (!bme_ok) {
    if (bme.begin(0x76, &Wire) || bme.begin(0x77, &Wire)) {
      Serial.println("[SENSORS] BME280 detected on retry!");
      bme_ok = true;
    }
  }

  if (bme_ok) {
    float t = bme.readTemperature();
    float h = bme.readHumidity();
    float p = bme.readPressure() / 100.0F;

    // Validate sensor readings: check for NaN, I2C bus dropouts, or out-of-bounds spikes
    if (isnan(t) || isnan(h) || isnan(p) || t < -40.0 || t > 80.0 || h < 0.0 || h > 100.0 || p < 300.0 || p > 1200.0) {
      Serial.printf("[SENSORS WARN] BME280 glitch/disconnect: T=%.1f, H=%.1f, P=%.1f. Marking offline for re-init.\n", t, h, p);
      bme_ok = false;
      current_air_temp = -999.0;
      current_humidity = -999.0;
      current_pressure = -999.0;
      diag += "BME:glitch(i2c=" + scan_i2c_bus() + "); ";
    } else {
      current_air_temp = t;
      current_humidity = h;
      current_pressure = p;
      diag += "BME:OK; ";
    }
  } else {
    current_air_temp = -999.0;
    current_humidity = -999.0;
    current_pressure = -999.0;
    diag += "BME:none(i2c=" + scan_i2c_bus() + "); ";
  }

  // 2. DS18B20 (Substrate Temp)
  pinMode(current_ds_pin, INPUT_PULLUP);
  gpio_pullup_en((gpio_num_t)current_ds_pin);
  int idle_lvl = digitalRead(current_ds_pin);
  int ow_presence = oneWire.reset();

  if (ow_presence == 1) {
    ds18b20.requestTemperatures();
    float t = ds18b20.getTempCByIndex(0);
    if (t > -100.0 && t < 125.0) {
      current_substrate_temp = t;
      diag += "DS:OK(pin" + String(current_ds_pin) + "=" + String(t, 1) + "C); ";
    } else {
      current_substrate_temp = -999.0;
      diag += "DS:ErrVal(" + String(t, 1) + "); ";
    }
  } else {
    current_substrate_temp = -999.0;
    diag += "DS:NoPulse(pin" + String(current_ds_pin) + ",lvl=" + String(idle_lvl) + "); ";
    // Try autodetect next candidate pin
    int new_pin = autodetect_ds18b20();
    if (new_pin != current_ds_pin) {
      current_ds_pin = new_pin;
      oneWire.begin(current_ds_pin);
      ds18b20.setOneWire(&oneWire);
    }
  }

  // 3. MH-Z19B
  current_co2_ppm = read_co2();
  if (current_co2_ppm != -999) {
    diag += "CO2:" + String(current_co2_ppm) + "ppm";
  } else {
    diag += "CO2:no_reply";
  }

  sensor_diag = diag;
  Serial.printf("[DIAG] %s\n", sensor_diag.c_str());
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

