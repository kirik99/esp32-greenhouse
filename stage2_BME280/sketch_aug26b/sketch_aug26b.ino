// ============================================================
//  ЭТАП 3 — BME280: температура, влажность, давление
//  Проект: Автоматизация теплицы
// ============================================================
//
//  Подключение DHT22 (Этап 2 — не меняем!):
//  DHT22 VCC  → ESP32 3.3V
//  DHT22 GND  → ESP32 GND
//  DHT22 DATA → ESP32 GPIO 4
//
//  Подключение BME280 (Этап 3):
//  BME280 VCC → ESP32 3.3V
//  BME280 GND → ESP32 GND
//  BME280 SCL → ESP32 GPIO 22
//  BME280 SDA → ESP32 GPIO 21
//
// ============================================================

#include "DHT.h"                // Библиотека для DHT22
#include <Wire.h>               // Библиотека I2C (встроена в Arduino)
#include <Adafruit_BME280.h>    // Библиотека для BME280

// --- DHT22 ---
#define DHT_PIN 4
#define DHT_TYPE DHT22
DHT dht(DHT_PIN, DHT_TYPE);

// --- BME280 ---
Adafruit_BME280 bme;           // Объект для работы с BME280

// Переменная для хранения статуса BME280
bool bme280_ok = false;

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("========================================");
  Serial.println("  Теплица ESP32 - СТАРТ");
  Serial.println("  Этап 3: DHT22 + BME280");
  Serial.println("========================================");

  // Запускаем DHT22
  dht.begin();
  Serial.println("  DHT22 инициализирован");

  // Запускаем BME280
  // Сначала пробуем адрес 0x76 (самый частый)
  if (bme.begin(0x76)) {
    Serial.println("  BME280 найден по адресу 0x76");
    bme280_ok = true;
  }
  // Если не нашли — пробуем адрес 0x77
  else if (bme.begin(0x77)) {
    Serial.println("  BME280 найден по адресу 0x77");
    bme280_ok = true;
  }
  else {
    Serial.println("  ОШИБКА: BME280 не найден!");
    Serial.println("  Проверь подключение SDA/SCL и питание.");
    bme280_ok = false;
  }

  Serial.println("========================================");
}

void loop() {
  delay(2000);

  // ---- DHT22 ----
  float hum_dht = dht.readHumidity();
  float temp_dht = dht.readTemperature();

  Serial.println("--- DHT22 ---");
  if (isnan(hum_dht) || isnan(temp_dht)) {
    Serial.println("  ОШИБКА: не удалось прочитать DHT22!");
  } else {
    Serial.print("  Температура: ");
    Serial.print(temp_dht);
    Serial.println(" C");

    Serial.print("  Влажность:   ");
    Serial.print(hum_dht);
    Serial.println(" %");
  }

  // ---- BME280 ----
  Serial.println("--- BME280 ---");
  if (!bme280_ok) {
    Serial.println("  BME280 недоступен — проверь подключение");
  } else {
    float temp_bme  = bme.readTemperature();          // °C
    float hum_bme   = bme.readHumidity();             // %
    float pres_bme  = bme.readPressure() / 100.0;    // гПа
    float pres_mmhg = pres_bme * 0.750064;            // мм рт. ст.

    Serial.print("  Температура: ");
    Serial.print(temp_bme);
    Serial.println(" C");

    Serial.print("  Влажность:   ");
    Serial.print(hum_bme);
    Serial.println(" %");

    Serial.print("  Давление:    ");
    Serial.print(pres_bme);
    Serial.print(" гПа  (");
    Serial.print(pres_mmhg);
    Serial.println(" мм рт.ст.)");
  }

  Serial.println("ESP32 работает");
  Serial.println();  // Пустая строка для удобства чтения
}