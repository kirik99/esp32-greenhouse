#include "sensors.h"
#include "config.h"
#include "relay.h"
#include <Wire.h>
#include <Adafruit_BME280.h>
#include <OneWire.h>
#include <DallasTemperature.h>

// ---------------------------------------------------------------------------
// BME280 (air temperature / humidity / pressure) on I2C
// ---------------------------------------------------------------------------
Adafruit_BME280 bme;
static uint8_t bme_addr = 0x76;
static int bme_fail_streak = 0;

// DS18B20 (substrate temperature) on GPIO 41
static int current_ds_pin = PIN_DS18B20;
static OneWire oneWire(PIN_DS18B20);
static DallasTemperature ds18b20(&oneWire);

// MH-Z19B (CO2) on Serial1
static bool mhz19_abc_pending = true;
static int last_co2_ppm = -999;
static int co2_same_streak = 0;

// Frozen-reading detection for the BME280
static bool bme_has_last = false;
static float last_bme_t = 0.0f;
static float last_bme_h = 0.0f;
static float last_bme_p = 0.0f;
static int bme_same_streak = 0;

float current_air_temp = -999.0;
float current_humidity = -999.0;
float current_pressure = -999.0;
float current_substrate_temp = -999.0;
int current_co2_ppm = -999;
String current_alarm = "NONE";
String sensor_diag = "Init";

bool sensor_bme_ok = false;
bool sensor_ds_ok = false;
bool sensor_co2_ok = false;
String sensor_bme_status = "INIT";
String sensor_ds_status = "INIT";
String sensor_co2_status = "INIT";
String i2c_devices = "unknown";
int i2c_sda_active = PIN_SDA;
int i2c_scl_active = PIN_SCL;

static bool wire_started = false;

// ---------------------------------------------------------------------------
// I2C helpers
// ---------------------------------------------------------------------------

static String hexByte(uint8_t value) {
  char buf[6];
  snprintf(buf, sizeof(buf), "0x%02X", value);
  return String(buf);
}

// (Re)start the I2C peripheral on the given pins. Needed because the bus can be
// left locked by a glitch (loose STEMMA QT cable) and nothing will ACK again
// until the peripheral is torn down and rebuilt.
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

// Result of an init attempt, so the dashboard can tell "nothing on the bus" apart
// from "something answers, but it is not a BME280" (very common with BMP280 clones
// that have no humidity channel at all).
enum BmeInitResult { BME_INIT_OK, BME_INIT_NOT_FOUND, BME_INIT_WRONG_CHIP };

static const char *bme_init_status(BmeInitResult result) {
  switch (result) {
    case BME_INIT_OK:         return "OK";
    case BME_INIT_WRONG_CHIP: return "WRONG_CHIP_ID";
    default:                  return "NOT_FOUND";
  }
}

static BmeInitResult bme_init_on_bus(int sda, int scl) {
  i2c_bus_begin(sda, scl);
  i2c_devices = i2c_scan_smart();

  bool addr_seen = false;
  const uint8_t candidates[] = {0x76, 0x77};
  for (uint8_t addr : candidates) {
    if (i2c_devices.indexOf(hexByte(addr)) >= 0) addr_seen = true;
    if (bme.begin(addr, &Wire)) {
      bme_addr = addr;
      bme_fail_streak = 0;
      // Explicitly use FORCED mode: with the library default (NORMAL) a chip that
      // silently ignores the control writes keeps serving the same data registers
      // for ever - live-looking but frozen values. Forced mode re-triggers a real
      bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                      Adafruit_BME280::SAMPLING_X2,
                      Adafruit_BME280::SAMPLING_X16,
                      Adafruit_BME280::SAMPLING_X1,
                      Adafruit_BME280::FILTER_X16,
                      Adafruit_BME280::STANDBY_MS_500);
      delay(100);
      // Discard initial conversion cycle before filter stabilizes
      bme.readTemperature();
      bme.readHumidity();
      bme.readPressure();
      bme_has_last = false;
      bme_same_streak = 0;
      Serial.printf("[SENSORS] BME280 found at %s (I2C SDA=%d SCL=%d, bus devices: %s)\n",
                    hexByte(addr).c_str(), sda, scl, i2c_devices.c_str());
      return BME_INIT_OK;
    }
  }

  if (addr_seen) {
    Serial.println("[SENSORS WARN] A device ACKs at 0x76/0x77 but does not report the BME280 chip "
                   "ID 0x60. This is usually a BMP280 clone without humidity - replace the module "
                   "with a real BME280.");
    return BME_INIT_WRONG_CHIP;
  }

  Serial.printf("[SENSORS] no BME280 at 0x76/0x77 (I2C SDA=%d SCL=%d, bus devices: %s)\n",
                sda, scl, i2c_devices.c_str());
  return BME_INIT_NOT_FOUND;
}

// ---------------------------------------------------------------------------
// Dedicated I2C Bus Detection for BME280 (SDA=GPIO 1, SCL=GPIO 2)
// ---------------------------------------------------------------------------

static BmeInitResult autodetect_bme280() {
  // First try the configured primary pair
  if (bme_init_on_bus(PIN_SDA, PIN_SCL) == BME_INIT_OK) {
    return BME_INIT_OK;
  }
  // Try swapped primary pair (in case SDA/SCL wires are inverted)
  if (bme_init_on_bus(PIN_SCL, PIN_SDA) == BME_INIT_OK) {
    return BME_INIT_OK;
  }

  // Fall back to default bus
  i2c_bus_begin(PIN_SDA, PIN_SCL);
  return BME_INIT_NOT_FOUND;
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
  // 1. Reset & start conversion
  if (!ds18b20_reset_pulse(pin)) {
    return -999.0f;
  }
  ds18b20_write_byte(pin, 0xCC); // Skip ROM
  ds18b20_write_byte(pin, 0x44); // Convert T

  // Wait conversion time (750ms for 12-bit)
  delay(750);

  // 2. Reset & read scratchpad
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
// Setup
// ---------------------------------------------------------------------------

void setup_sensors() {
  BmeInitResult bme_result = autodetect_bme280();
  sensor_bme_ok = (bme_result == BME_INIT_OK);
  sensor_bme_status = bme_init_status(bme_result);

  current_ds_pin = PIN_DS18B20;
  pinMode(current_ds_pin, INPUT_PULLUP);
  gpio_pullup_en((gpio_num_t)current_ds_pin);
  oneWire.begin(current_ds_pin);
  ds18b20.setOneWire(&oneWire);
  ds18b20.begin();
  ds18b20_hw_init(current_ds_pin);
  Serial.printf("[SENSORS] DS18B20 initialized on GPIO %d (idle level=%d)\n",
                current_ds_pin, digitalRead(current_ds_pin));

  // MH-Z19B on the hardware UART
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
    Serial1.read();  // drop stale bytes so the reply cannot be misaligned
  }
  Serial1.write(frame, 9);
  Serial1.flush();
}

// Disable Automatic Baseline Calibration: in a growbox the CO2 level never drops
// to the outdoor 400 ppm baseline, so ABC would slowly drift the readings to zero.
static void mhz19_disable_abc() {
  uint8_t cmd[9] = {0xFF, 0x01, 0x79, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  cmd[8] = mhz19_checksum(cmd);
  mhz19_send(cmd);
  Serial.println("[SENSORS] MH-Z19B ABC (auto-calibration) disabled for mushroom cultivation.");
}

void calibrate_co2_zero() {
  // Winsen MH-Z19B zero-point calibration (treats current air as the 400 ppm baseline)
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

// One 9-byte exchange with strict 0xFF 0x86 frame synchronization.
static int mhz19_read_once() {
  while (Serial1.available() > 0) {
    Serial1.read();  // clear rx fifo
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
// BME280 validation + recovery
// ---------------------------------------------------------------------------

static bool valid_temp(float t) { return !isnan(t) && t > -40.0f && t < 80.0f; }
static bool valid_hum(float h)  { return !isnan(h) && h >= 0.0f && h <= 100.0f; }
static bool valid_pres(float p) { return !isnan(p) && p > 300.0f && p < 1200.0f; }

static void bme_recover_bus() {
  Serial.printf("[SENSORS] BME280 unreadable %d times in a row: rebuilding the I2C bus...\n",
                bme_fail_streak);
  BmeInitResult result = bme_init_on_bus(i2c_sda_active, i2c_scl_active);
  sensor_bme_ok = (result == BME_INIT_OK);
  sensor_bme_status = sensor_bme_ok ? "RECOVERED" : bme_init_status(result);
}

// ---------------------------------------------------------------------------
// Main read cycle
// ---------------------------------------------------------------------------

void read_sensors() {
  String diag = "";

  // 1. BME280 (air temperature / humidity / pressure)
  if (!sensor_bme_ok) {
    BmeInitResult result = autodetect_bme280();
    if (result == BME_INIT_OK) {
      sensor_bme_ok = true;
      sensor_bme_status = "OK";
      Serial.println("[SENSORS] BME280 detected on retry!");
    } else {
      sensor_bme_status = bme_init_status(result);
    }
  }

  if (sensor_bme_ok) {
    float t = bme.readTemperature();
    float h = bme.readHumidity();
    float p = bme.readPressure() / 100.0F;

    if (!valid_temp(t) || !valid_hum(h) || !valid_pres(p)) {
      delay(50);
      t = bme.readTemperature();
      h = bme.readHumidity();
      p = bme.readPressure() / 100.0F;
    }

    const bool t_ok = valid_temp(t);
    const bool h_ok = t_ok && valid_hum(h);
    const bool p_ok = t_ok && valid_pres(p);
    const bool any_ok = t_ok && (h_ok || p_ok);

    const bool frozen = false;
    if (t_ok && h_ok && p_ok) {
      last_bme_t = t;
      last_bme_h = h;
      last_bme_p = p;
      bme_has_last = true;
      bme_fail_streak = 0;
    }
    bme_same_streak = 0;

    if (!any_ok) {
      current_air_temp = -999.0;
      current_humidity = -999.0;
      current_pressure = -999.0;
      bme_fail_streak++;
      sensor_bme_status = "READ_ERROR";
      Serial.printf("[SENSORS WARN] BME280 read failed (streak %d): T=%.2f H=%.2f P=%.2f\n",
                    bme_fail_streak, t, h, p);
      diag += "BME:read_error(x" + String(bme_fail_streak) + "); ";
      if (bme_fail_streak >= 5) {
        bme_recover_bus();
      }
    } else {
      // Validate every channel on its own: a single bad channel (NAN humidity on a
      // BMP280-style clone, or one glitched I2C burst) must not wipe the good ones.
      current_air_temp = t_ok ? t : -999.0;
      current_humidity = h_ok ? h : -999.0;
      current_pressure = p_ok ? p : -999.0;
      bme_fail_streak = 0;
      sensor_bme_status = h_ok ? "OK" : "OK_NO_HUMIDITY";
      diag += "BME:" + hexByte(bme_addr) + (h_ok ? " OK; " : " OK(no humidity); ");
    }
  } else {
    current_air_temp = -999.0;
    current_humidity = -999.0;
    current_pressure = -999.0;
    diag += "BME:not_found(i2c=" + i2c_devices + "@" + String(i2c_sda_active) + "/" +
            String(i2c_scl_active) + "); ";
  }

  // 2. DS18B20 (substrate temperature)
  pinMode(current_ds_pin, INPUT_PULLUP);
  gpio_pullup_en((gpio_num_t)current_ds_pin);
  int idle_lvl = digitalRead(current_ds_pin);

  float t_sub = -999.0f;

  // Attempt 1: Standard OneWire / DallasTemperature
  int ow_presence = oneWire.reset();
  if (ow_presence == 1) {
    ds18b20.requestTemperatures();
    float t = ds18b20.getTempCByIndex(0);
    if (t > -55.0f && t < 125.0f) {
      t_sub = t;
    }
  }

  // Attempt 2: Direct Hardware Open-Drain driver
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

  // 3. MH-Z19B (CO2)
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
