#ifndef BME_DIAG_H
#define BME_DIAG_H

#include <Arduino.h>

void init_bme280();
void read_bme280();
bool is_bme280_ready();
uint8_t get_bme280_address();
uint8_t get_bme280_chip_id();

#endif // BME_DIAG_H
