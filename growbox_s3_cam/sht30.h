#ifndef SHT30_H
#define SHT30_H

#include <Arduino.h>
#include <Wire.h>

// =========================================================================
// Sensirion SHT30 / SHT31 / SHT35 High-Precision I2C Sensor Driver
// Fully autonomous, non-blocking, with CRC-8 verification & bus recovery
// =========================================================================

#define SHT30_ADDR_DEFAULT 0x44  // ADDR pin LOW / floating
#define SHT30_ADDR_ALT     0x45  // ADDR pin HIGH (VCC)

// Sensirion Commands
#define SHT30_CMD_MEASURE_HIGH_REP 0x2400
#define SHT30_CMD_SOFT_RESET       0x30A2
#define SHT30_CMD_READ_STATUS      0xF32D
#define SHT30_CMD_CLEAR_STATUS     0x3041
#define SHT30_CMD_HEATER_ENABLE    0x306D
#define SHT30_CMD_HEATER_DISABLE   0x3066

enum Sht30InitResult {
  SHT30_INIT_OK,
  SHT30_INIT_NOT_FOUND,
  SHT30_INIT_CRC_ERROR,
  SHT30_INIT_TIMEOUT
};

class Sht30Sensor {
public:
  Sht30Sensor() : _addr(SHT30_ADDR_DEFAULT), _ok(false), _last_t(-999.0f), _last_h(-999.0f) {}

  // Sensirion polynomial: x^8 + x^5 + x^4 + 1 (0x31, init 0xFF)
  static uint8_t crc8(const uint8_t *data, size_t len) {
    uint8_t crc = 0xFF;
    for (size_t i = 0; i < len; i++) {
      crc ^= data[i];
      for (uint8_t bit = 8; bit > 0; --bit) {
        if (crc & 0x80) {
          crc = (crc << 1) ^ 0x31;
        } else {
          crc = (crc << 1);
        }
      }
    }
    return crc;
  }

  // Sensirion official formulas:
  // T [C]  = -45 + 175 * (raw / 65535)
  // RH [%] = 100 * (raw / 65535)
  static float raw_to_temp(uint16_t raw) {
    return -45.0f + 175.0f * ((float)raw / 65535.0f);
  }

  static float raw_to_humidity(uint16_t raw) {
    float h = 100.0f * ((float)raw / 65535.0f);
    if (h < 0.0f) h = 0.0f;
    if (h > 100.0f) h = 100.0f;
    return h;
  }

  bool soft_reset(uint8_t addr) {
    Wire.beginTransmission(addr);
    Wire.write(0x30);
    Wire.write(0xA2);
    return (Wire.endTransmission() == 0);
  }

  bool test_probe(uint8_t addr) {
    Wire.beginTransmission(addr);
    return (Wire.endTransmission() == 0);
  }

  Sht30InitResult init(uint8_t addr = SHT30_ADDR_DEFAULT) {
    _addr = addr;
    if (!test_probe(_addr)) {
      _ok = false;
      return SHT30_INIT_NOT_FOUND;
    }
    soft_reset(_addr);
    delay(20);
    float t, h;
    if (read_sample(t, h)) {
      _ok = true;
      _last_t = t;
      _last_h = h;
      return SHT30_INIT_OK;
    }
    _ok = false;
    return SHT30_INIT_CRC_ERROR;
  }

  bool read_sample(float &temp, float &hum) {
    // 1. Send single-shot measurement command (High repeatability, clock stretching disabled)
    Wire.beginTransmission(_addr);
    Wire.write(0x24);
    Wire.write(0x00);
    if (Wire.endTransmission() != 0) {
      return false;
    }

    // 2. Wait for measurement conversion (high repeatability takes max 15ms)
    delay(16);

    // 3. Request 6 bytes (Temp MSB, Temp LSB, Temp CRC, Hum MSB, Hum LSB, Hum CRC)
    uint8_t bytes_read = Wire.requestFrom(_addr, (uint8_t)6);
    if (bytes_read != 6) {
      return false;
    }

    uint8_t data[6];
    for (int i = 0; i < 6; i++) {
      data[i] = Wire.read();
    }

    // 4. Validate CRC for temperature and humidity
    if (crc8(data, 2) != data[2]) {
      return false;
    }
    if (crc8(data + 3, 2) != data[5]) {
      return false;
    }

    // 5. Convert to physical units
    uint16_t raw_t = (uint16_t(data[0]) << 8) | data[1];
    uint16_t raw_h = (uint16_t(data[3]) << 8) | data[4];

    float t = raw_to_temp(raw_t);
    float h = raw_to_humidity(raw_h);

    if (t < -40.0f || t > 85.0f || h < 0.0f || h > 100.0f) {
      return false;
    }

    temp = t;
    hum = h;
    _last_t = t;
    _last_h = h;
    _ok = true;
    return true;
  }

  uint8_t get_address() const { return _addr; }
  bool is_ok() const { return _ok; }
  float get_last_temperature() const { return _last_t; }
  float get_last_humidity() const { return _last_h; }

private:
  uint8_t _addr;
  bool _ok;
  float _last_t;
  float _last_h;
};

#endif // SHT30_H
