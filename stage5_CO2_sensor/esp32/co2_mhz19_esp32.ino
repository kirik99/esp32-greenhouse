#include <Arduino.h>

HardwareSerial CO2Serial(1);

const int CO2_RX = 8;   // RX ESP32-S3 <- TX MH-Z19
const int CO2_TX = 18;  // TX ESP32-S3 -> RX MH-Z19

void setup() {
  Serial.begin(115200);
  delay(3000);

  CO2Serial.begin(9600, SERIAL_8N1, CO2_RX, CO2_TX);

  Serial.println();
  Serial.println("================================");
  Serial.println("      MH-Z19 + ESP32-S3");
  Serial.println("================================");
  Serial.println("VCC -> 3.3V");
  Serial.println("GND -> GND");
  Serial.println("TX  -> GPIO8");
  Serial.println("RX  -> GPIO18");
  Serial.println();
}

void loop() {

  uint8_t cmd[9] = {
    0xFF, 0x01, 0x86,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x79
  };

  while (CO2Serial.available()) {
    CO2Serial.read();
  }

  Serial.println("Отправляю запрос...");

  CO2Serial.write(cmd, 9);
  CO2Serial.flush();

  delay(1000);

  int count = CO2Serial.available();

  Serial.print("Получено байт: ");
  Serial.println(count);

  if (count >= 9) {

    uint8_t response[9];

    for (int i = 0; i < 9; i++) {
      response[i] = CO2Serial.read();
    }

    Serial.print("Ответ HEX: ");

    for (int i = 0; i < 9; i++) {
      if (response[i] < 16) Serial.print("0");
      Serial.print(response[i], HEX);
      Serial.print(" ");
    }

    Serial.println();

    if (response[0] == 0xFF &&
        response[1] == 0x86) {

      int ppm = response[2] * 256 + response[3];

      Serial.print("CO2 = ");
      Serial.print(ppm);
      Serial.println(" ppm");

    } else {
      Serial.println("Неизвестный ответ");
    }

  } else {
    Serial.println("НЕТ ОТВЕТА ОТ MH-Z19");
  }

  Serial.println("--------------------------------");

  delay(3000);
}