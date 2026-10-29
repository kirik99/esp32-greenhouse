#include <cstdint>
#include <cassert>
#include <cstdio>
#include <cmath>

static uint8_t sht30_crc8(const uint8_t *data, size_t len) {
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

static float sht30_raw_to_temp(uint16_t raw) {
  return -45.0f + 175.0f * ((float)raw / 65535.0f);
}

static float sht30_raw_to_humidity(uint16_t raw) {
  float h = 100.0f * ((float)raw / 65535.0f);
  if (h < 0.0f) h = 0.0f;
  if (h > 100.0f) h = 100.0f;
  return h;
}

static bool sht30_is_valid_temp(float t) {
  return !std::isnan(t) && t >= -40.0f && t <= 85.0f;
}

static bool sht30_is_valid_humidity(float h) {
  return !std::isnan(h) && h >= 0.0f && h <= 100.0f;
}

int main() {
  // Test 1: Sensirion standard test vector 0xBEEF -> 0x92
  uint8_t test_vector[2] = {0xBE, 0xEF};
  uint8_t crc = sht30_crc8(test_vector, 2);
  assert(crc == 0x92);
  printf("[PASS] CRC8 Sensirion test vector 0xBEEF -> 0x92\n");

  // Test 2: Temperature conversion
  // Zero raw -> -45C
  assert(std::fabs(sht30_raw_to_temp(0) - (-45.0f)) < 0.001f);
  // Max raw 65535 -> +130C
  assert(std::fabs(sht30_raw_to_temp(65535) - 130.0f) < 0.001f);
  // Typical room temperature ~24C: raw ~ 25850
  float t_room = sht30_raw_to_temp(25850);
  assert(t_room > 23.0f && t_room < 25.0f);
  assert(sht30_is_valid_temp(t_room));
  printf("[PASS] Temperature conversion and validation\n");

  // Test 3: Humidity conversion
  assert(std::fabs(sht30_raw_to_humidity(0) - 0.0f) < 0.001f);
  assert(std::fabs(sht30_raw_to_humidity(65535) - 100.0f) < 0.001f);
  float h_mushroom = sht30_raw_to_humidity(62258); // ~95%
  assert(h_mushroom > 94.0f && h_mushroom < 96.0f);
  assert(sht30_is_valid_humidity(h_mushroom));
  printf("[PASS] Humidity conversion and validation\n");

  // Test 4: Range limits
  assert(!sht30_is_valid_temp(-999.0f));
  assert(!sht30_is_valid_humidity(-999.0f));
  assert(!sht30_is_valid_temp(100.0f)); // Above max greenhouse limit

  printf("[ALL TESTS PASSED] SHT30 Core Logic Verified!\n");
  return 0;
}
