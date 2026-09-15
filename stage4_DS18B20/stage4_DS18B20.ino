#include <OneWire.h>
#include <DallasTemperature.h>

// =============================
// DS18B20
// =============================

#define ONE_WIRE_BUS 4

OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

// =============================
// SETUP
// =============================

void setup() {

  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("================================");
  Serial.println("       DS18B20 СТАРТ");
  Serial.println("================================");

  sensors.begin();

  int count = sensors.getDeviceCount();

  Serial.print("Найдено DS18B20: ");
  Serial.println(count);

  if (count == 0) {
    Serial.println("ОШИБКА: DS18B20 не найден!");
    Serial.println("Проверь VCC, GND, DATA и резистор 4.7 кОм.");
  }
}

// =============================
// LOOP
// =============================

void loop() {

  sensors.requestTemperatures();

  float temperature = sensors.getTempCByIndex(0);

  Serial.println();
  Serial.println("-------- СУБСТРАТ --------");

  if (temperature == DEVICE_DISCONNECTED_C) {

    Serial.println("DS18B20: ОШИБКА / НЕТ СВЯЗИ");

  } else {

    Serial.print("Температура субстрата: ");
    Serial.print(temperature, 2);
    Serial.println(" °C");
  }

  Serial.println("--------------------------");

  delay(2000);
}