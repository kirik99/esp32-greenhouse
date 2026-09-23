#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_BME280.h>

/**
 * test_bme280_i2c.ino - Полная аппаратная диагностика I2C и BME280
 *
 * Проверяет:
 * 1. Сканирование шины I2C на STEMMA QT (SDA=16, SCL=17) и на альтернативных пинах (SDA=6, SCL=7).
 * 2. Чтение регистра CHIP_ID (0xD0):
 *    - 0x60 = Оригинальный BME280 (Температура + Влажность + Давление).
 *    - 0x58 = Клон BMP280 (ТОЛЬКО Температура и Давление! Влажности физически нет).
 *    - 0x00 / 0xFF = Обрыв линии, нет контакта или питания.
 * 3. Непрерывный опрос раз в 1.5 секунды с выводом данных в Serial Monitor (115200 baud).
 */

Adafruit_BME280 bme;
int sda_pin = 16;
int scl_pin = 17;
uint8_t found_addr = 0;
bool bme_initialized = false;

void scanBus(int sda, int scl, const char* busName) {
  Serial.printf("\n--- Сканирование шины %s (SDA=%d, SCL=%d) ---\n", busName, sda, scl);
  Wire.end();
  delay(20);
  Wire.begin(sda, scl);
  Wire.setClock(100000);
  delay(50);

  int devices = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();
    if (error == 0) {
      Serial.printf("  [+] Найдено устройство на адресе 0x%02X", addr);
      if (addr == 0x76 || addr == 0x77) {
        Serial.print(" <--- ЭТО ВАШ BME280 / BMP280!");
        found_addr = addr;
        sda_pin = sda;
        scl_pin = scl;
      } else if (addr == 0x19) {
        Serial.print(" (Встроенный акселерометр LIS3DH платы MatrixPortal)");
      }
      Serial.println();
      devices++;
    }
  }

  if (devices == 0) {
    Serial.println("  [-] Устройств не обнаружено (линия I2C пуста).");
  }
}

uint8_t readChipId(uint8_t addr) {
  Wire.beginTransmission(addr);
  Wire.write(0xD0); // Регистр идентификатора чипа Bosch
  Wire.endTransmission();
  Wire.requestFrom(addr, (uint8_t)1);
  if (Wire.available()) {
    return Wire.read();
  }
  return 0xFF;
}

void setup() {
  Serial.begin(115200);
  delay(2500);

  Serial.println("\n==================================================");
  Serial.println("   ТЕСТ ДАТЧИКА BME280 / BMP280 (ESP32-S3)");
  Serial.println("==================================================");
  Serial.println("ВАЖНО ПО ПИТАНИЮ:");
  Serial.println("• BME280 питается от 3.3V (разъем STEMMA QT или пин 3V)!");
  Serial.println("• НЕ подавайте 5V на чип BME280 без отдельного стабилизатора!\n");

  // 1. Сканируем разъем STEMMA QT (GPIO 16/17)
  scanBus(16, 17, "STEMMA QT (основной)");

  // 2. Если не нашли, сканируем альтернативные пины (GPIO 6/7)
  if (found_addr == 0) {
    scanBus(6, 7, "GPIO 6/7 (альтернативный)");
  }

  if (found_addr == 0) {
    Serial.println("\n[ОШИБКА]: Датчик BME280 НЕ ОБНАРУЖЕН ни на одной паре пинов!");
    Serial.println("Что проверить:");
    Serial.println(" 1. Кабель STEMMA QT / провода: плотно ли вставлен разъем?");
    Serial.println(" 2. Питание: приходит ли 3.3V и GND на датчик?");
    Serial.println(" 3. Если датчик на макетке: проверьте подтяжку SDA к 3.3V и SCL к 3.3V (4.7 кОм).");
    return;
  }

  // 3. Проверяем Chip ID
  uint8_t chipId = readChipId(found_addr);
  Serial.printf("\n[CHIP ID]: Прочитан регистр 0xD0 = 0x%02X\n", chipId);
  if (chipId == 0x60) {
    Serial.println(">>> УСПЕХ: Это полноценный BME280 (Температура + Давление + Влажность)!");
  } else if (chipId == 0x58) {
    Serial.println(">>> ВНИМАНИЕ: Это клон BMP280! У него НЕТ датчика влажности (только T и P).");
    Serial.println("    В приложении влажность будет показывать 0% или NaN.");
  } else {
    Serial.printf(">>> НЕИЗВЕСТНЫЙ ЧИП (0x%02X). Возможен плохой контакт на линии SDA.\n", chipId);
  }

  // 4. Инициализация библиотеки Adafruit
  if (bme.begin(found_addr, &Wire)) {
    Serial.println("[OK] Библиотека Adafruit_BME280 успешно инициализирована.");
    bme.setSampling(Adafruit_BME280::MODE_FORCED,
                    Adafruit_BME280::SAMPLING_X1, // temp
                    Adafruit_BME280::SAMPLING_X1, // pressure
                    Adafruit_BME280::SAMPLING_X1, // humidity
                    Adafruit_BME280::FILTER_OFF);
    bme_initialized = true;
  } else {
    Serial.println("[ERR] bme.begin() вернул false. Проверьте питание датчика.");
  }
}

void loop() {
  if (!bme_initialized) {
    delay(2000);
    return;
  }

  // Заставляем датчик сделать новый физический замер
  bme.takeForcedMeasurement();

  float t = bme.readTemperature();
  float h = bme.readHumidity();
  float p = bme.readPressure() / 100.0F;

  Serial.printf("[%lu ms] Температура: %.2f °C | Влажность: %.2f %% | Давление: %.1f hPa\n",
                millis(), t, h, p);

  delay(1500);
}
