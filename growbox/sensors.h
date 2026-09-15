#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>

void setup_sensors();
void read_sensors();

extern float current_air_temp;
extern float current_humidity;
extern float current_pressure;
extern float current_substrate_temp;
extern int current_co2_ppm;

#endif
