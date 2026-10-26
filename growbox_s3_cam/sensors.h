#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>

void setup_sensors();
void read_sensors();
void check_safety_failsafes();
void calibrate_co2_zero();

extern float current_air_temp;
extern float current_humidity;
extern float current_pressure;
extern float current_substrate_temp;
extern int current_co2_ppm;
extern String current_alarm;
extern String sensor_diag;

// Air sensor (SHT30, replaces BME280)
extern bool sensor_sht_ok;
extern String sensor_sht_status;
extern uint8_t sht_i2c_addr;

// Backward-compatibility aliases
extern bool sensor_bme_ok;
extern String sensor_bme_status;

extern bool sensor_ds_ok;
extern bool sensor_co2_ok;
extern String sensor_ds_status;
extern String sensor_co2_status;
extern String i2c_devices;
extern int i2c_sda_active;
extern int i2c_scl_active;

#endif // SENSORS_H
