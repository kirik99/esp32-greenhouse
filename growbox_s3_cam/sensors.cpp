#include "sensors.h"
#include "config.h"
#include "relay.h"
#include "sht30.h"
#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ---------------------------------------------------------------------------
// Sensirion SHT30 (Air Temperature & Humidity) on I2C
// ---------------------------------------------------------------------------
static Sht30Sensor sht30;
uint8_t sht_i2c_addr = SHT30_ADDR_DEFAULT;
static int sht_fail_streak = 0;

bool sensor_sht_ok = false;
String sensor_sht_status = "INIT";

// Backward-compatibility aliases (for MQTT & web dashboard)
bool sensor_bme_ok = false;
String sensor_bme_status = "INIT";

// DS18B20 (substrate temperature) on GPIO 41
static int current_ds_pin = PIN_DS18B20;
static OneWire oneWire(PIN_DS18B20);
static DallasTemperature ds18b20(&oneWire);

// MH-Z19B (CO2) on Serial1
static bool mhz19_abc_pending = true;
static int last_co2_ppm = -999;
static int co2_same_streak = 0;

float current_air_temp = -999.0f;
float current_humidity = -999.0f;
float current_pressure = -999.0f;
float current_substrate_temp = -999.0f;
int current_co2_ppm = -999;
String current_alarm = "NONE";
String sensor_diag = "Init";

bool sensor_ds_ok = false;
bool sensor_co2_ok = false;
String sensor_ds_status = "INIT";
String sensor_co2_status = "INIT";
String i2c_devices = "unknown";
int i2c_sda_active = PIN_SDA;
int i2c_scl_active = PIN_SCL;

static bool wire_started = false;

// ---------------------------------------------------------------------------
// I2C helpers & Bus Management
// ---------------------------------------------------------------------------

static String hexByte(uint8_t value) {
  char buf[6];
  snprintf(buf, sizeof(buf), "0x%02X", value);
  return String(buf);
}

static void i2c_bus_begin(int sda, int scl) {
  if (wire_started) {
    Wire.end();
    wire_started = false;
    delay(20);
  }
  Wire.setPins(sda, scl);
  Wire.begin(sda, scl, 100000);
  Wire.setTimeOut(50);
  wire_started = true;
  i2c_sda_active = sda;
  i2c_scl_active = scl;
  delay(50);
}

static String i2c_scan_smart() {
  String found = "";
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      if (found.length()) found += ",";
      found += hexByte(addr);
    }
  }
  return found.length() ? found : String("none");
}

static bool sht30_init_on_bus(int sda, int scl) {
  i2c_bus_begin(sda, scl);
  i2c_devices = i2c_scan_smart();

  const uint8_t candidates[] = {SHT30_ADDR_DEFAULT, SHT30_ADDR_ALT};
  for (uint8_t addr : candidates) {
    if (i2c_devices.indexOf(hexByte(addr)) >= 0) {
      if (sht30.init(addr) == SHT30_INIT_OK) {
        sht_i2c_addr = addr;
        sht_fail_streak = 0;
        sensor_sht_ok = true;
        sensor_sht_status = "OK";
        sensor_bme_ok = true;
        sensor_bme_status = "OK";
        Serial.printf("[SENSORS] SHT30 found at %s (I2C SDA=%d SCL=%d, bus devices: %s)\n",
                      hexByte(addr).c_str(), sda, scl, i2c_devices.c_str());
        return true;
      }
    }
  }

  Serial.printf("[SENSORS] No SHT30 at 0x44/0x45 (I2C SDA=%d SCL=%d, bus devices: %s)\n",
                sda, scl, i2c_devices.c_str());
  return false;
}

static void autodetect_sht30() {
  // Attempt 1: Configured primary pair (SDA=GPIO 1, SCL=GPIO 2)
  if (sht30_init_on_bus(PIN_SDA, PIN_SCL)) {
    return;
  }

#if I2C_FALLBACK_ENABLED
  // Attempt 2: Swapped pair (in case Green and Blue wires are swapped: SDA=GPIO 2, SCL=GPIO 1)
  Serial.println("[SENSORS] SHT30 not detected on primary pins. Testing swapped lines (SDA <-> SCL)...");
  if (sht30_init_on_bus(PIN_SCL, PIN_SDA)) {
    Serial.printf("[SENSORS OK] SHT30 auto-detected with swapped lines (SDA=%d, SCL=%d)!\n",
                  PIN_SCL, PIN_SDA);
    return;
  }
#endif

  // Restore primary pin configuration
  i2c_bus_begin(PIN_SDA, PIN_SCL);
  sensor_sht_ok = false;
  sensor_sht_status = "NOT_FOUND";
  sensor_bme_ok = false;
  sensor_bme_status = "NOT_FOUND";
}

static void sht_recover_bus() {
  Serial.printf("[SENSORS] SHT30 unreadable %d times in a row: recovering I2C bus...\n",
                sht_fail_streak);
  autodetect_sht30();
}

// ---------------------------------------------------------------------------
// Native ESP32-S3 Hardware Open-Drain 1-Wire / DS18B20 Driver
// ---------------------------------------------------------------------------

static void ds18b20_hw_init(int pin) {
  gpio_config_t io_conf = {};
  io_conf.intr_type = GPIO_INTR_DISABLE;
  io_conf.mode = GPIO_MODE_INPUT_OUTPUT_OD;
  io_conf.pin_bit_mask = (1ULL << pin);
  io_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
  io_conf.pull_up_en = GPIO_PULLUP_ENABLE;
  gpio_config(&io_conf);
  gpio_set_level((gpio_num_t)pin, 1);
  delay(10);
}

static inline void ds18b20_low(int pin) {
  gpio_set_level((gpio_num_t)pin, 0);
}

static inline void ds18b20_high(int pin) {
  gpio_set_level((gpio_num_t)pin, 1);
}

static inline int ds18b20_read_level(int pin) {
  return gpio_get_level((gpio_num_t)pin);
}

static bool ds18b20_reset_pulse(int pin) {
  ds18b20_high(pin);
  delayMicroseconds(5);

  ds18b20_low(pin);
  delayMicroseconds(480);

  noInterrupts();
  ds18b20_high(pin);
  delayMicroseconds(70);
  int presence = !ds18b20_read_level(pin);
  interrupts();

  delayMicroseconds(410);
  ds18b20_high(pin);

  return presence == 1;
}

static void ds18b20_write_bit(int pin, int bit) {
  if (bit) {
    noInterrupts();
    ds18b20_low(pin);
    delayMicroseconds(6);
    ds18b20_high(pin);
    interrupts();
    delayMicroseconds(64);
  } else {
    noInterrupts();
    ds18b20_low(pin);
    delayMicroseconds(60);
    ds18b20_high(pin);
    interrupts();
    delayMicroseconds(10);
  }
}

static int ds18b20_read_bit(int pin) {
  noInterrupts();
  ds18b20_low(pin);
  delayMicroseconds(3);
  ds18b20_high(pin);
  delayMicroseconds(10);
  int bit = ds18b20_read_level(pin);
  interrupts();
  delayMicroseconds(53);
  return bit;
}

static void ds18b20_write_byte(int pin, uint8_t byte) {
  for (int i = 0; i < 8; i++) {
    ds18b20_write_bit(pin, (byte >> i) & 1);
  }
}

static uint8_t ds18b20_read_byte(int pin) {
  uint8_t byte = 0;
  for (int i = 0; i < 8; i++) {
    if (ds18b20_read_bit(pin)) {
      byte |= (1 << i);
    }
  }
  return byte;
}

static float ds18b20_read_temp_c(int pin) {
  if (!ds18b20_reset_pulse(pin)) {
    return -999.0f;
  }
  ds18b20_write_byte(pin, 0xCC); // Skip ROM
  ds18b20_write_byte(pin, 0x44); // Convert T

  delay(750); // 12-bit conversion delay

  if (!ds18b20_reset_pulse(pin)) {
    return -999.0f;
  }
  ds18b20_write_byte(pin, 0xCC); // Skip ROM
  ds18b20_write_byte(pin, 0xBE); // Read Scratchpad
  uint8_t lsb = ds18b20_read_byte(pin);
  uint8_t msb = ds18b20_read_byte(pin);

  int16_t raw = (int16_t)((msb << 8) | lsb);
  float temp_c = (float)raw / 16.0f;
  if (temp_c > -55.0f && temp_c < 125.0f) {
    return temp_c;
  }
  return -999.0f;
}

// ---------------------------------------------------------------------------
// Setup Sensors
// ---------------------------------------------------------------------------

void setup_sensors() {
  Serial.println("[SENSORS] Initializing SHT30 air temperature & humidity sensor...");
  autodetect_sht30();

  current_ds_pin = PIN_DS18B20;
  pinMode(current_ds_pin, INPUT_PULLUP);
  gpio_pullup_en((gpio_num_t)current_ds_pin);
  oneWire.begin(current_ds_pin);
  ds18b20.setOneWire(&oneWire);
  ds18b20.begin();
  ds18b20_hw_init(current_ds_pin);
  Serial.printf("[SENSORS] DS18B20 initialized on GPIO %d (idle level=%d)\n",
                current_ds_pin, digitalRead(current_ds_pin));

  Serial1.begin(MHZ19_BAUD, SERIAL_8N1, PIN_MHZ19_RX, PIN_MHZ19_TX);
  delay(50);
  Serial.printf("[SENSORS] MH-Z19B UART ready (RX=%d, TX=%d, %d baud). VIN must be 5V!\n",
                PIN_MHZ19_RX, PIN_MHZ19_TX, MHZ19_BAUD);

  Serial.printf("[SENSORS] I2C bus active on SDA=%d SCL=%d, devices: %s\n",
                i2c_sda_active, i2c_scl_active, i2c_devices.c_str());
}

// Winsen MH-Z19B checksum: 0xFF - (sum of bytes 1..7) + 1
static uint8_t mhz19_checksum(const uint8_t *frame) {
  uint8_t sum = 0;
  for (int i = 1; i < 8; i++) {
    sum += frame[i];
  }
  return (uint8_t)(0xFF - sum + 1);
}

static void mhz19_send(const uint8_t *frame) {
  while (Serial1.available() > 0) {
    Serial1.read();
  }
  Serial1.write(frame, 9);
  Serial1.flush();
}

static void mhz19_disable_abc() {
  uint8_t cmd[9] = {0xFF, 0x01, 0x79, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  cmd[8] = mhz19_checksum(cmd);
  mhz19_send(cmd);
  Serial.println("[SENSORS] MH-Z19B ABC (auto-calibration) disabled for mushroom cultivation.");
}

void calibrate_co2_zero() {
  uint8_t cmd[9] = {0xFF, 0x01, 0x87, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  cmd[8] = mhz19_checksum(cmd);
  mhz19_send(cmd);
  Serial.println("[CO2] Zero-point calibration command sent (400 ppm baseline)!");
}

#define MHZ19_ERR_NO_REPLY  -1
#define MHZ19_ERR_BAD_FRAME -2
#define MHZ19_ERR_BAD_CRC   -3

static const char *mhz19_error_text(int code) {
  switch (code) {
    case MHZ19_ERR_NO_REPLY:  return "no_reply";
    case MHZ19_ERR_BAD_FRAME: return "bad_frame";
    case MHZ19_ERR_BAD_CRC:   return "bad_checksum";
    default:                  return "error";
  }
}

static int mhz19_internal_temp = -999;

static int mhz19_read_once() {
  while (Serial1.available() > 0) {
    Serial1.read();
  }

  uint8_t cmd[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x79};
  Serial1.write(cmd, 9);
  Serial1.flush();

  uint8_t response[9];
  memset(response, 0, sizeof(response));

  int got = 0;
  unsigned long start = millis();
  while ((millis() - start) < MHZ19_RESPONSE_TIMEOUT_MS) {
    if (Serial1.available() > 0) {
      uint8_t b = (uint8_t)Serial1.read();
      if (got == 0) {
        if (b == 0xFF) response[got++] = b;
      } else if (got == 1) {
        if (b == 0x86) {
          response[got++] = b;
        } else if (b == 0xFF) {
          response[0] = 0xFF;
        } else {
          got = 0;
        }
      } else {
        response[got++] = b;
        if (got >= 9) break;
      }
    } else {
      delay(2);
    }
  }

  if (got < 9) return MHZ19_ERR_NO_REPLY;
  if (response[0] != 0xFF || response[1] != 0x86) return MHZ19_ERR_BAD_FRAME;
  if (mhz19_checksum(response) != response[8]) return MHZ19_ERR_BAD_CRC;

  int ppm = (response[2] << 8) | response[3];
  mhz19_internal_temp = (int)response[4] - 40;
  return ppm;
}

static int mhz19_read_ppm() {
  int last = MHZ19_ERR_NO_REPLY;
  for (int attempt = 0; attempt <= MHZ19_MAX_RETRIES; attempt++) {
    last = mhz19_read_once();
    if (last > 0) return last;
    if (attempt < MHZ19_MAX_RETRIES) delay(50);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Main read cycle
// ---------------------------------------------------------------------------

void read_sensors() {
  String diag = "";

  // 1. SHT30: Air Temperature & Humidity
  float sht_t = -999.0f;
  float sht_h = -999.0f;
  if (sht30.read_sample(sht_t, sht_h)) {
    current_air_temp = sht_t;
    current_humidity = sht_h;
    current_pressure = -999.0f; // SHT30 does not measure barometric pressure
    sensor_sht_ok = true;
    sensor_sht_status = "OK";
    sensor_bme_ok = true;
    sensor_bme_status = "OK";
    sht_fail_streak = 0;
    diag += "SHT:OK(" + String(sht_t, 1) + "C," + String(sht_h, 1) + "%); ";
  } else {
    sht_fail_streak++;
    if (sht_fail_streak >= SHT_STALE_CYCLES) {
      sht_recover_bus();
    }
    current_air_temp = -999.0f;
    current_humidity = -999.0f;
    current_pressure = -999.0f;
    sensor_sht_ok = false;
    sensor_sht_status = (sht_fail_streak >= SHT_STALE_CYCLES) ? "NOT_FOUND" : "READ_ERROR";
    sensor_bme_ok = false;
    sensor_bme_status = sensor_sht_status;
    diag += "SHT:" + sensor_sht_status + "(streak=" + String(sht_fail_streak) + "); ";
  }

  // 2. DS18B20: Substrate Temperature
  pinMode(current_ds_pin, INPUT_PULLUP);
  gpio_pullup_en((gpio_num_t)current_ds_pin);
  int idle_lvl = digitalRead(current_ds_pin);

  float t_sub = -999.0f;

  int ow_presence = oneWire.reset();
  if (ow_presence == 1) {
    ds18b20.requestTemperatures();
    float t = ds18b20.getTempCByIndex(0);
    if (t > -55.0f && t < 125.0f) {
      t_sub = t;
    }
  }

  if (t_sub <= -55.0f || t_sub >= 125.0f) {
    ds18b20_hw_init(current_ds_pin);
    float t_hw = ds18b20_read_temp_c(current_ds_pin);
    if (t_hw > -55.0f && t_hw < 125.0f) {
      t_sub = t_hw;
    }
  }

  if (t_sub > -55.0f && t_sub < 125.0f) {
    current_substrate_temp = t_sub;
    sensor_ds_ok = true;
    sensor_ds_status = "OK";
    diag += "DS:OK(pin" + String(current_ds_pin) + "=" + String(t_sub, 1) + "C); ";
  } else {
    current_substrate_temp = -999.0f;
    sensor_ds_ok = false;
    sensor_ds_status = "NO_PULSE";
    diag += "DS:NoPulse(pin" + String(current_ds_pin) + ",lvl=" + String(idle_lvl) + "); ";
  }

  // 3. MH-Z19B: CO2
  if (mhz19_abc_pending && millis() > MHZ19_WARMUP_MS) {
    mhz19_disable_abc();
    mhz19_abc_pending = false;
  }

  int co2 = mhz19_read_ppm();
  if (co2 > 0) {
    co2_same_streak = (co2 == last_co2_ppm) ? (co2_same_streak + 1) : 0;
    last_co2_ppm = co2;
    current_co2_ppm = co2;
    sensor_co2_ok = true;

    unsigned long up_sec = millis() / 1000;
    if (up_sec < 180 && co2 == 400) {
      sensor_co2_status = "PREHEATING";
      diag += "CO2:" + String(co2) + "ppm(warmup " + String(up_sec) + "s/180s";
      if (mhz19_internal_temp > -100) diag += ",t=" + String(mhz19_internal_temp) + "C";
      diag += ")";
    } else {
      sensor_co2_status = "OK";
      diag += "CO2:" + String(co2) + "ppm";
      if (mhz19_internal_temp > -100) diag += "(t=" + String(mhz19_internal_temp) + "C)";
    }
  } else {
    current_co2_ppm = -999;
    sensor_co2_ok = false;
    sensor_co2_status = mhz19_error_text(co2);
    diag += "CO2:" + sensor_co2_status;
    if (co2 == MHZ19_ERR_NO_REPLY) {
      diag += "(check 5V, RX->GPIO39, TX->GPIO40)";
    }
  }

  sensor_diag = diag;
  Serial.printf("[DIAG] %s\n", sensor_diag.c_str());
  Serial.printf("Sensors: Air=%.2fC, Hum=%.2f%%, Sub=%.2fC, CO2=%dppm (SHT30: %s at 0x%02X)\n",
                current_air_temp, current_humidity, current_substrate_temp, current_co2_ppm,
                sensor_sht_status.c_str(), sht_i2c_addr);

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
    if (get_relay(1)) {
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
  if (current_air_temp < -100.0 && current_substrate_temp < -100.0) {
    if (get_relay(2)) {
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
