#include "bme_diag.h"
#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include "config.h"

static Adafruit_BME280 bme;
static bool bme280_initialized = false;
static uint8_t bme280_address = 0;
static uint8_t bme280_chip_id = 0;

struct I2CPinPair {
  int sda;
  int scl;
  const char *desc;
};

static const I2CPinPair CANDIDATE_PINS[] = {
  { UNCONFIRMED_I2C_SDA, UNCONFIRMED_I2C_SCL, "Configured UNCONFIRMED pins" },
  { 1,  2, "General Breakout Header GPIO 1 / 2" },
  { 2,  1, "General Breakout Header GPIO 2 / 1" },
  { 8,  9, "ESP32-S3 Core Default SDA=8, SCL=9" },
  { 4,  5, "Camera SCCB Bus SDA=4, SCL=5" },
  { 17, 16, "Reversed Candidate GPIO 17 / 16" },
  { 41, 42, "High Header GPIO 41 / 42" },
};
static const size_t NUM_CANDIDATE_PINS = sizeof(CANDIDATE_PINS) / sizeof(CANDIDATE_PINS[0]);

static uint8_t read_i2c_reg(uint8_t addr, uint8_t reg) {
  Wire.beginTransmission(addr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    return 0xFF;
  }
  if (Wire.requestFrom((int)addr, 1) == 1) {
    return Wire.read();
  }
  return 0xFF;
}

static bool scan_and_init_bme280_on_pins(int sda, int scl, const char *tag) {
  Serial.printf("[BME280] Testing I2C on SDA=GPIO %d, SCL=GPIO %d (%s)...\n", sda, scl, tag);
  Wire.end();
  delay(50);
  if (!Wire.begin(sda, scl, 100000)) {
    Serial.println("[BME280 ERR] Failed to initialize I2C bus with Wire.begin()!");
    return false;
  }

  Serial.println("[BME280] I2C scan started");
  uint8_t found_addr = 0;
  int device_count = 0;

  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    uint8_t error = Wire.endTransmission();
    if (error == 0) {
      Serial.printf("[BME280] Device found at 0x%02X\n", address);
      device_count++;
      if (address == BME280_PRIMARY_ADDR || address == BME280_SECONDARY_ADDR) {
        found_addr = address;
      }
    }
  }

  if (device_count == 0) {
    Serial.printf("[BME280] No I2C devices responded on SDA=%d, SCL=%d.\n", sda, scl);
    return false;
  }

  if (found_addr == 0) {
    Serial.printf("[BME280 WARN] Devices found on bus, but neither 0x76 nor 0x77 detected.\n");
    return false;
  }

  // Check Chip ID register (0xD0)
  uint8_t chip_id = read_i2c_reg(found_addr, 0xD0);
  Serial.printf("[BME280] Device found at 0x%02X (Chip ID register: 0x%02X)\n", found_addr, chip_id);

  if (chip_id == BME280_CHIP_ID) {
    Serial.println("[BME280] Chip ID verified: 0x60 (Genuine BME280 Temperature + Humidity + Pressure)");
  } else if (chip_id == BMP280_CHIP_ID) {
    Serial.println("[BME280 WARN] Chip ID is 0x58: BMP280 detected (Pressure + Temp only, NO humidity sensor!)");
  } else {
    Serial.printf("[BME280 WARN] Unknown chip ID 0x%02X (Expected 0x60 for BME280)\n", chip_id);
  }

  // Initialize Adafruit library
  if (!bme.begin(found_addr, &Wire)) {
    Serial.println("[BME280 ERR] Adafruit_BME280 library begin() failed!");
    return false;
  }

  // Sensor configuration for climate monitoring
  bme.setSampling(Adafruit_BME280::MODE_NORMAL,
                  Adafruit_BME280::SAMPLING_X2,  // temperature
                  Adafruit_BME280::SAMPLING_X16, // pressure
                  Adafruit_BME280::SAMPLING_X1,  // humidity
                  Adafruit_BME280::FILTER_X16,
                  Adafruit_BME280::STANDBY_MS_500);

  bme280_initialized = true;
  bme280_address = found_addr;
  bme280_chip_id = chip_id;
  Serial.println("[BME280] Initialization: OK");

  // Initial read to confirm physical readings
  float t = bme.readTemperature();
  float h = bme.readHumidity();
  float p = bme.readPressure() / 100.0F;

  Serial.printf("[BME280] Temperature: %.1f C\n", t);
  Serial.printf("[BME280] Humidity: %.1f %%\n", h);
  Serial.printf("[BME280] Pressure: %.1f hPa\n", p);

  return true;
}

void init_bme280() {
  Serial.println("\n[STAGE B] ===============================================");
  Serial.println("[STAGE B] Starting BME280 I2C Diagnostics");
  Serial.printf("[STAGE B] Configured Pins: SDA=GPIO %d, SCL=GPIO %d [STATUS: UNCONFIRMED]\n", 
                UNCONFIRMED_I2C_SDA, UNCONFIRMED_I2C_SCL);
  Serial.println("[STAGE B] ===============================================");

  // First try the configured UNCONFIRMED pin pair
  if (scan_and_init_bme280_on_pins(UNCONFIRMED_I2C_SDA, UNCONFIRMED_I2C_SCL, "Primary UNCONFIRMED")) {
    Serial.printf("[BME280 OK] BME280 successfully verified on SDA=GPIO %d, SCL=GPIO %d!\n", 
                  UNCONFIRMED_I2C_SDA, UNCONFIRMED_I2C_SCL);
    return;
  }

  Serial.println("\n[BME280 DIAGNOSTIC] Sensor NOT found on primary configured pins.");
  Serial.println("[BME280 DIAGNOSTIC] Possible causes:");
  Serial.println("  1. Incorrect SDA / SCL GPIO pin assignment;");
  Serial.println("  2. Missing 3.3V power or GND connection;");
  Serial.println("  3. Missing I2C pull-up resistors (typically 4.7k to 3.3V);");
  Serial.println("  4. Sensor address mismatch or damaged sensor module;");
  Serial.println("  5. Conflict with camera DVP bus (GPIO 16/17 are camera data lines).");
  Serial.println("[BME280 DIAGNOSTIC] Scanning alternative candidate pin pairs on header...\n");

  for (size_t i = 1; i < NUM_CANDIDATE_PINS; i++) {
    if (scan_and_init_bme280_on_pins(CANDIDATE_PINS[i].sda, CANDIDATE_PINS[i].scl, CANDIDATE_PINS[i].desc)) {
      Serial.println("\n*******************************************************");
      Serial.printf("[BME280 FOUND] SENSOR RESPONDED ON ALTERNATIVE PINS: SDA=GPIO %d, SCL=GPIO %d (%s)!\n", 
                    CANDIDATE_PINS[i].sda, CANDIDATE_PINS[i].scl, CANDIDATE_PINS[i].desc);
      Serial.println("[BME280 FOUND] Update UNCONFIRMED_I2C_SDA and UNCONFIRMED_I2C_SCL in config.h to confirm.");
      Serial.println("*******************************************************\n");
      return;
    }
    delay(50);
  }

  Serial.println("[BME280 ERR] All candidate pin scans exhausted. BME280 is offline.");
}

void read_bme280() {
  if (!bme280_initialized) {
    Serial.println("[BME280 ERR] Cannot read: BME280 is not initialized.");
    return;
  }

  float t = bme.readTemperature();
  float h = bme.readHumidity();
  float p = bme.readPressure() / 100.0F;

  // Validation check: real physics limits
  bool valid = (!isnan(t) && t >= -40.0 && t <= 85.0) &&
               (!isnan(h) && h >= 0.0 && h <= 100.0) &&
               (!isnan(p) && p >= 300.0 && p <= 1100.0);

  if (valid) {
    Serial.printf("[BME280] Temperature: %.1f C\n", t);
    Serial.printf("[BME280] Humidity: %.1f %%\n", h);
    Serial.printf("[BME280] Pressure: %.1f hPa\n", p);
  } else {
    Serial.printf("[BME280 ERR] Invalid or out-of-range readings: T=%.2f, H=%.2f, P=%.2f\n", t, h, p);
  }
}

bool is_bme280_ready() {
  return bme280_initialized;
}

uint8_t get_bme280_address() {
  return bme280_address;
}

uint8_t get_bme280_chip_id() {
  return bme280_chip_id;
}
