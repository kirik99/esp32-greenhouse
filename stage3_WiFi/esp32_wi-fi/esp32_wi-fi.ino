// ============================================================
// ЭТАП 3 — Настройка и проверка Wi-Fi
// Проект: Автоматизация теплицы
// Плата: ESP32-WROOM-32D
//
// ВАЖНО: Создайте файл wifi_config.h (он в .gitignore)
//        по образцу wifi_config.example.h
//        и укажите в нём ваш SSID и пароль.
// ============================================================

#include <WiFi.h>
#include "wifi_config.h"  // SSID и пароль хранятся здесь (в .gitignore)

// ============================================================
// НАСТРОЙКИ
// ============================================================

const unsigned long WIFI_TIMEOUT  = 15000; // 15 секунд
const unsigned long CHECK_INTERVAL = 5000; //  5 секунд

unsigned long lastCheck = 0;

// ============================================================
// ПОДКЛЮЧЕНИЕ К WI-FI
// ============================================================

bool connectToWiFi() {

  Serial.println();
  Serial.println("========================================");
  Serial.println("        ПОДКЛЮЧЕНИЕ К WI-FI");
  Serial.println("========================================");

  Serial.print("Сеть: ");
  Serial.println(WIFI_SSID);
  Serial.println("Подключение...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startTime = millis();

  while (WiFi.status() != WL_CONNECTED &&
         millis() - startTime < WIFI_TIMEOUT) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {

    Serial.println();
    Serial.println("========================================");
    Serial.println("          WI-FI ПОДКЛЮЧЕН!");
    Serial.println("========================================");
    Serial.print("SSID: ");       Serial.println(WiFi.SSID());
    Serial.print("IP ESP32: ");   Serial.println(WiFi.localIP());
    Serial.print("Маска: ");      Serial.println(WiFi.subnetMask());
    Serial.print("Шлюз: ");       Serial.println(WiFi.gatewayIP());
    Serial.print("Сигнал: ");     Serial.print(WiFi.RSSI()); Serial.println(" dBm");
    Serial.println("========================================");
    return true;

  } else {

    Serial.println();
    Serial.println("========================================");
    Serial.println("          ОШИБКА WI-FI");
    Serial.println("========================================");
    Serial.println("ESP32 не смогла подключиться.");
    Serial.println("Проверь: 1. Имя сети  2. Пароль  3. Роутер");
    Serial.println("========================================");
    return false;
  }
}

// ============================================================
// SETUP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("========================================");
  Serial.println("       ТЕПЛИЦА ESP32 - СТАРТ");
  Serial.println("========================================");
  Serial.println("Этап 3: Проверка Wi-Fi");

  connectToWiFi();
}

// ============================================================
// LOOP
// ============================================================

void loop() {

  if (millis() - lastCheck >= CHECK_INTERVAL) {
    lastCheck = millis();
    Serial.println();

    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("Wi-Fi: OK");
      Serial.print("IP ESP32: "); Serial.println(WiFi.localIP());
      Serial.print("Сигнал: ");   Serial.print(WiFi.RSSI()); Serial.println(" dBm");
    } else {
      Serial.println("Wi-Fi: ОТКЛЮЧЕН — пробуем снова...");
      connectToWiFi();
    }
  }
}
