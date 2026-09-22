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

// DS18B20 (substrate temperature) on OneWire
OneWire oneWire(PIN_DS18B20);
DallasTemperature ds18b20(&oneWire);
static int current_ds_pin = PIN_DS18B20;

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
    delay(10);
  }
  Wire.begin(sda, scl);
  Wire.setClock(100000);
  Wire.setTimeOut(50);
  wire_started = true;
  i2c_sda_active = sda;
  i2c_scl_active = scl;
  delay(50);
}

static bool i2c_probe(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission(true) == 0;  // true == device ACKed
}

// The MatrixPortal S3 carries an onboard LIS3DH accelerometer at 0x19 on the very
// same STEMMA QT bus, so an ACK at 0x19 proves that the bus itself is alive even
// when the BME280 is missing or miswired.
static const uint8_t I2C_QUICK_PROBE[] = {0x19, 0x76, 0x77, 0x38, 0x40, 0x44, 0x48, 0x3C, 0x68, 0x5C};

static String i2c_scan_full() {
  String found;
  for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
    if (!i2c_probe(addr)) continue;
    if (found.length()) found += ",";
    found += hexByte(addr);
  }
  return found.length() ? found : String("none");
}

// Probe the interesting addresses first. If literally nothing answers (not even
// the onboard accelerometer) the bus is dead / unpowered, and a 100+ address
// sweep would only stall the main loop for several seconds.
static String i2c_scan_smart() {
  for (uint8_t addr : I2C_QUICK_PROBE) {
    if (i2c_probe(addr)) {
      return i2c_scan_full();
    }
  }
  return String("none");
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
      // conversion on every read cycle, and it also avoids self-heating.
      bme.setSampling(Adafruit_BME280::MODE_FORCED);
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
// DS18B20 helpers
// ---------------------------------------------------------------------------

int autodetect_ds18b20() {
  const int candidate_pins[] = {PIN_DS18B20, 5, 13, 6, 7};
  for (int p : candidate_pins) {
    // Never poke the pins that are currently driving the I2C bus.
    if (p == i2c_sda_active || p == i2c_scl_active) continue;
    pinMode(p, INPUT_PULLUP);
    OneWire testOw(p);
    if (testOw.reset() == 1) {
      Serial.printf("[SENSORS] DS18B20 detected on GPIO %d!\n", p);
      return p;
    }
  }
  return PIN_DS18B20;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

void setup_sensors() {
  BmeInitResult bme_result = bme_init_on_bus(PIN_SDA, PIN_SCL);
  sensor_bme_ok = (bme_result == BME_INIT_OK);
  sensor_bme_status = bme_init_status(bme_result);

#if I2C_FALLBACK_ENABLED
  // Early revisions of this project wired the BME280 to GPIO 6/7. Try that pair
  // so an existing harness keeps working, but shout about it.
  if (!sensor_bme_ok && (PIN_I2C_FALLBACK_SDA != PIN_SDA || PIN_I2C_FALLBACK_SCL != PIN_SCL)) {
    Serial.printf("[SENSORS] retrying BME280 on legacy I2C pins (SDA=%d SCL=%d)...\n",
                  PIN_I2C_FALLBACK_SDA, PIN_I2C_FALLBACK_SCL);
    BmeInitResult legacy_result = bme_init_on_bus(PIN_I2C_FALLBACK_SDA, PIN_I2C_FALLBACK_SCL);
    if (legacy_result == BME_INIT_OK) {
      sensor_bme_ok = true;
      sensor_bme_status = "OK_LEGACY_PINS";
      Serial.println("[SENSORS WARN] BME280 answers on the LEGACY GPIO 6/7 pins. "
                     "Move SDA/SCL to the STEMMA QT port (GPIO 16/17).");
    } else {
      // Nothing anywhere: go back to the standard bus so the diagnostics and the
      // reported pin numbers stay meaningful.
      i2c_bus_begin(PIN_SDA, PIN_SCL);
      i2c_devices = i2c_scan_smart();
      sensor_bme_status = bme_init_status(legacy_result);
    }
  }
#endif

  current_ds_pin = autodetect_ds18b20();
  pinMode(current_ds_pin, INPUT_PULLUP);
  oneWire.begin(current_ds_pin);
  ds18b20.setOneWire(&oneWire);
  ds18b20.begin();

  // MH-Z19B on the hardware UART (board pins RX=8 / TX=18).
  // VIN must be 5V - on 3.3V the sensor never answers.
  Serial1.begin(MHZ19_BAUD, SERIAL_8N1, PIN_MHZ19_RX, PIN_MHZ19_TX);
  delay(50);
  Serial.printf("[SENSORS] MH-Z19B UART ready (RX=%d, TX=%d, %d baud). "
                "VIN must be 5V!\n", PIN_MHZ19_RX, PIN_MHZ19_TX, MHZ19_BAUD);

  Serial.printf("[SENSORS] I2C bus SDA=%d SCL=%d, devices: %s\n",
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

// One 9-byte exchange. Returns ppm (> 0) or a negative MHZ19_ERR_* code.
static int mhz19_read_once() {
  uint8_t cmd[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  cmd[8] = mhz19_checksum(cmd);
  mhz19_send(cmd);

  uint8_t response[9];
  int got = 0;
  unsigned long start = millis();
  while (got < 9 && (millis() - start) < MHZ19_RESPONSE_TIMEOUT_MS) {
    if (Serial1.available() > 0) {
      response[got++] = (uint8_t)Serial1.read();
    } else {
      delay(2);
    }
  }

  if (got < 9) return MHZ19_ERR_NO_REPLY;
  if (response[0] != 0xFF || response[1] != 0x86) return MHZ19_ERR_BAD_FRAME;
  if (mhz19_checksum(response) != response[8]) return MHZ19_ERR_BAD_CRC;

  return (response[2] * 256) + response[3];
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
    BmeInitResult result = bme_init_on_bus(i2c_sda_active, i2c_scl_active);
    if (result == BME_INIT_OK) {
      sensor_bme_ok = true;
      sensor_bme_status = "OK";
      Serial.println("[SENSORS] BME280 detected on retry!");
    } else {
      sensor_bme_status = bme_init_status(result);
    }
  }

  if (sensor_bme_ok) {
    // Trigger a real conversion first; reading the registers without it is exactly
    // how "frozen but plausible" telemetry appears.
    const bool converted = bme.takeForcedMeasurement();

    float t = bme.readTemperature();
    float h = bme.readHumidity();
    float p = bme.readPressure() / 100.0F;

    const bool t_ok = valid_temp(t);
    const bool h_ok = valid_hum(h);
    const bool p_ok = valid_pres(p);
    const bool any_ok = t_ok || h_ok || p_ok;

    // Frozen-register detector: with a working chip the raw values always move a
    // little (0.01 C / 0.01 hPa resolution), so identical T+H+P three cycles in a
    // row means the chip is not measuring at all.
    const bool frozen = t_ok && h_ok && p_ok && bme_has_last &&
                        t == last_bme_t && h == last_bme_h && p == last_bme_p;
    if (t_ok && h_ok && p_ok) {
      last_bme_t = t;
      last_bme_h = h;
      last_bme_p = p;
      bme_has_last = true;
    }
    bme_same_streak = frozen ? (bme_same_streak + 1) : 0;

    if (!any_ok) {
      current_air_temp = -999.0;
      current_humidity = -999.0;
      current_pressure = -999.0;
      bme_fail_streak++;
      sensor_bme_status = converted ? "READ_ERROR" : "MEASURE_TRIGGER_FAILED";
      Serial.printf("[SENSORS WARN] BME280 read failed (streak %d, forced=%d): T=%.2f H=%.2f P=%.2f\n",
                    bme_fail_streak, (int)converted, t, h, p);
      diag += "BME:read_error(x" + String(bme_fail_streak) + "); ";
      if (bme_fail_streak >= 2) {
        bme_recover_bus();
      }
    } else if (frozen && bme_same_streak >= (BME_STALE_CYCLES - 1)) {
      // Report nothing rather than publishing frozen numbers as live data.
      current_air_temp = -999.0;
      current_humidity = -999.0;
      current_pressure = -999.0;
      sensor_bme_status = "STALE_NO_NEW_DATA";
      Serial.printf("[SENSORS WARN] BME280 reports the SAME values for %d cycles "
                    "(T=%.2f H=%.2f P=%.2f): the chip performs no new measurements. "
                    "Typical cause: fake/defective module or failed control-register writes.\n",
                    bme_same_streak + 1, t, h, p);
      diag += "BME:stale(T=" + String(t, 2) + " H=" + String(h, 2) + " P=" + String(p, 1) +
              ") - no new measurements; replace the module or fix its wiring; ";
      bme_same_streak = 0;
      bme_recover_bus();
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
  int idle_lvl = digitalRead(current_ds_pin);
  int ow_presence = oneWire.reset();

  if (ow_presence == 1) {
    ds18b20.requestTemperatures();
    float t = ds18b20.getTempCByIndex(0);
    if (t > -100.0 && t < 125.0) {
      current_substrate_temp = t;
      sensor_ds_ok = true;
      sensor_ds_status = "OK";
      diag += "DS:OK(pin" + String(current_ds_pin) + "=" + String(t, 1) + "C); ";
    } else {
      current_substrate_temp = -999.0;
      sensor_ds_ok = false;
      sensor_ds_status = "BAD_VALUE";
      diag += "DS:ErrVal(" + String(t, 1) + "); ";
    }
  } else {
    current_substrate_temp = -999.0;
    sensor_ds_ok = false;
    sensor_ds_status = "NO_PULSE";
    diag += "DS:NoPulse(pin" + String(current_ds_pin) + ",lvl=" + String(idle_lvl) + "); ";
    // Try autodetect on the next candidate pin
    int new_pin = autodetect_ds18b20();
    if (new_pin != current_ds_pin) {
      current_ds_pin = new_pin;
      oneWire.begin(current_ds_pin);
      ds18b20.setOneWire(&oneWire);
      ds18b20.begin();
    }
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

    if (co2 >= CO2_SUSPICIOUS_PPM && co2_same_streak >= (CO2_STALE_CYCLES - 1)) {
      // 5000 ppm is the value MH-Z19B reports while preheating or when its IR lamp
      // cannot reach the measurement range - usually an underpowered (3.3 V) or
      // worn-out sensor. Keep showing it, but say out loud that it never moves.
      sensor_co2_status = "STUCK_5000_PREHEAT_OR_FAULT";
      Serial.printf("[SENSORS WARN] MH-Z19B reports %d ppm unchanged for %d cycles: "
                    "preheat/fault value. Check VIN = 5V and wait 3 minutes after power-up.\n",
                    co2, co2_same_streak + 1);
      diag += "CO2:" + String(co2) + "ppm(frozen preheat/fault value - check 5V VIN, "
              "let it warm up 3 min, replace sensor if it never drops)";
    } else if (co2_same_streak >= (CO2_STALE_CYCLES - 1)) {
      sensor_co2_status = "STALE_NO_NEW_DATA";
      Serial.printf("[SENSORS WARN] MH-Z19B reports %d ppm unchanged for %d cycles.\n",
                    co2, co2_same_streak + 1);
      diag += "CO2:" + String(co2) + "ppm(frozen for " + String(co2_same_streak + 1) + " cycles)";
    } else {
      sensor_co2_status = "OK";
      diag += "CO2:" + String(co2) + "ppm";
    }
  } else {
    current_co2_ppm = -999;
    sensor_co2_ok = false;
    sensor_co2_status = mhz19_error_text(co2);
    // No reply almost always means: VIN is not on 5V, TX/RX are not crossed, or
    // the sensor is still preheating.
    diag += "CO2:" + sensor_co2_status;
    if (co2 == MHZ19_ERR_NO_REPLY) {
      diag += "(check 5V VIN, sensor TX->GPIO8, sensor RX->GPIO18)";
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
