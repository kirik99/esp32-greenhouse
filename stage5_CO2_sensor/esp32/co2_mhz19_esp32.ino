#include <Arduino.h>

HardwareSerial CO2Serial(1);

const int CO2_RX = 8;   // RX ESP32-S3 <- TX MH-Z19
const int CO2_TX = 18;  // TX ESP32-S3 -> RX MH-Z19

// Winsen checksum: 0xFF - (sum of bytes 1..7) + 1
uint8_t mhz19Checksum(const uint8_t *frame) {
  uint8_t sum = 0;
  for (int i = 1; i < 8; i++) sum += frame[i];
  return (uint8_t)(0xFF - sum + 1);
}

void setup() {
  Serial.begin(115200);
  delay(3000);

  CO2Serial.begin(9600, SERIAL_8N1, CO2_RX, CO2_TX);

  Serial.println();
  Serial.println("================================");
  Serial.println("      MH-Z19 + ESP32-S3");
  Serial.println("================================");
  Serial.println("VCC -> 5V   (ОБЯЗАТЕЛЬНО 5В! на 3.3В сенсор молчит)");
  Serial.println("GND -> GND  (общая земля с ESP32)");
  Serial.println("TX  сенсора -> GPIO8  (RX платы)");
  Serial.println("RX  сенсора -> GPIO18 (TX платы)");
  Serial.println();

  // Отключаем автоматическую калибровку нуля: в гроубоксе уровень CO2
  // никогда не опускается к уличным 400 ppm, и ABC медленно уводит показания.
  uint8_t abc[9] = {0xFF, 0x01, 0x79, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00};
  abc[8] = mhz19Checksum(abc);
  delay(500);
  CO2Serial.write(abc, 9);
  CO2Serial.flush();
  Serial.println("ABC (авто-калибровка) отключена");
  Serial.println();
}

void loop() {

  uint8_t cmd[9] = {
    0xFF, 0x01, 0x86,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00
  };
  cmd[8] = mhz19Checksum(cmd);

  while (CO2Serial.available()) {
    CO2Serial.read();
  }

  Serial.println("Отправляю запрос...");

  CO2Serial.write(cmd, 9);
  CO2Serial.flush();

  uint8_t response[9];
  int got = 0;
  unsigned long start = millis();
  while (got < 9 && (millis() - start) < 500) {
    if (CO2Serial.available()) {
      response[got++] = (uint8_t)CO2Serial.read();
    } else {
      delay(2);
    }
  }

  Serial.print("Получено байт: ");
  Serial.println(got);

  if (got >= 9) {

    Serial.print("Ответ HEX: ");

    for (int i = 0; i < 9; i++) {
      if (response[i] < 16) Serial.print("0");
      Serial.print(response[i], HEX);
      Serial.print(" ");
    }

    Serial.println();

    if (response[0] == 0xFF &&
        response[1] == 0x86) {

      if (mhz19Checksum(response) != response[8]) {
        Serial.println("ОШИБКА: неверная контрольная сумма (помехи на линии / плохой контакт)");
      } else {
        int ppm = response[2] * 256 + response[3];

        Serial.print("CO2 = ");
        Serial.print(ppm);
        Serial.println(" ppm");
      }

    } else {
      Serial.println("Неизвестный ответ");
    }

  } else {
    Serial.println("НЕТ ОТВЕТА ОТ MH-Z19");
    Serial.println("Проверьте: 1) VIN подключён к 5В (не 3.3В!); 2) GND общий;");
    Serial.println("           3) TX сенсора -> GPIO8, RX сенсора -> GPIO18;");
    Serial.println("           4) сенсору нужно ~1-3 минуты прогрева после включения.");
  }

  Serial.println("--------------------------------");

  delay(3000);
}
