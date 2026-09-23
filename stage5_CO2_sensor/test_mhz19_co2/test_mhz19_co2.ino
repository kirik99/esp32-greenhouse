#include <Arduino.h>

/**
 * test_mhz19_co2.ino - Полная аппаратная диагностика датчика CO2 (MH-Z19B)
 *
 * КРИТИЧЕСКИ ВАЖНО ПО ПИТАНИЮ:
 * 1. VIN датчика MH-Z19B ОБЯЗАН быть подключен к 5V (пин VBUS / 5V платы или внешний 5V БП)!
 *    Если подать 3.3V, оптическая лампа не зажигается -> датчик зависает и выдает РОВНО 5000 ppm!
 * 2. GND датчика -> GND платы ESP32.
 * 3. TX датчика -> GPIO 8 (RX платы ESP32-S3).
 * 4. RX датчика -> GPIO 18 (TX платы ESP32-S3).
 *
 * Логические уровни UART: датчик сам выдает 3.3V TTL сигналы, поэтому делитель не нужен.
 */

HardwareSerial CO2Serial(1);
const int PIN_RX = 8;   // RX ESP32 <- TX MH-Z19B
const int PIN_TX = 18;  // TX ESP32 -> RX MH-Z19B

uint8_t mhz19Checksum(const uint8_t *frame) {
  uint8_t sum = 0;
  for (int i = 1; i < 8; i++) sum += frame[i];
  return (uint8_t)(0xFF - sum + 1);
}

void setup() {
  Serial.begin(115200);
  delay(2500);

  Serial.println("\n==================================================");
  Serial.println("   ТЕСТ ДАТЧИКА УГЛЕКИСЛОГО ГАЗА MH-Z19B");
  Serial.println("==================================================");
  Serial.println("ПРОВЕРКА ПОДКЛЮЧЕНИЯ:");
  Serial.println(" • VIN сенсора -> 5V (ОБЯЗАТЕЛЬНО 5 ВОЛЬТ! На 3.3В сенсор выдает 5000 ppm!)");
  Serial.println(" • GND сенсора -> GND платы");
  Serial.println(" • TX  сенсора -> GPIO 8  (RX ESP32-S3)");
  Serial.println(" • RX  сенсора -> GPIO 18 (TX ESP32-S3)\n");

  CO2Serial.begin(9600, SERIAL_8N1, PIN_RX, PIN_TX);

  // Отключаем автоматическую калибровку нуля (ABC)
  uint8_t disable_abc[9] = {0xFF, 0x01, 0x79, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  disable_abc[8] = mhz19Checksum(disable_abc);
  delay(100);
  CO2Serial.write(disable_abc, 9);
  CO2Serial.flush();
  Serial.println("[OK] Команда отключения автокалибровки ABC отправлена.");
  Serial.println("Начинаем цикличный опрос каждые 2 секунды...\n");
}

void loop() {
  // Очищаем входной буфер от старых байт
  while (CO2Serial.available() > 0) {
    CO2Serial.read();
  }

  // Команда запроса концентрации газа (0x86)
  uint8_t cmd[9] = {0xFF, 0x01, 0x86, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  cmd[8] = mhz19Checksum(cmd);

  CO2Serial.write(cmd, 9);
  CO2Serial.flush();

  // Ожидаем ответ (9 байт)
  uint8_t response[9];
  int received = 0;
  unsigned long start = millis();

  while (received < 9 && (millis() - start) < 600) {
    if (CO2Serial.available()) {
      response[received++] = (uint8_t)CO2Serial.read();
    } else {
      delay(2);
    }
  }

  if (received == 0) {
    Serial.println("[ОШИБКА]: Датчик МОЛЧИТ (0 байт получено).");
    Serial.println(" -> Проверьте: подключен ли VIN к 5V? Не перепутаны ли TX и RX местами (GPIO8 и GPIO18)?");
  } else if (received < 9) {
    Serial.printf("[ОШИБКА]: Неполный ответ (%d из 9 байт).\n", received);
  } else {
    // Выводим сырые байты в HEX для диагностики
    Serial.print("[HEX]: ");
    for (int i = 0; i < 9; i++) {
      Serial.printf("%02X ", response[i]);
    }

    if (response[0] != 0xFF || response[1] != 0x86) {
      Serial.println(" -> ОШИБКА: Неверный заголовок кадра!");
    } else if (mhz19Checksum(response) != response[8]) {
      Serial.println(" -> ОШИБКА: Контрольная сумма CRC не совпала!");
    } else {
      int ppm = (response[2] * 256) + response[3];
      Serial.printf(" --> CO2: %d ppm ", ppm);

      if (ppm == 5000) {
        Serial.println("[!] ВНИМАНИЕ: Ровно 5000 ppm — датчик в режиме прогрева (3 мин) ЛИБО на VIN подано 3.3V вместо 5V!");
      } else if (ppm < 400) {
        Serial.println("(Подозрительно низкое значение, норма свежего воздуха 400-450 ppm)");
      } else if (ppm > 2500) {
        Serial.println("(Высокая концентрация)");
      } else {
        Serial.println("(Нормальный отклик датчика)");
      }
    }
  }

  delay(2000);
}
