# Отчёт и руководство: Диагностика HZAD ESP32-S3 WROOM N16R8 CAM (Этап 1 — ЗАВЕРШЁН)

## 1. Аппаратная платформа и конфигурация сборки

Все параметры подтверждены реальными вызовами API прошивки на физическом устройстве:
- **Плата / Модуль:** ESP32-S3-WROOM-1 (N16R8)
- **Модель чипа:** ESP32-S3 (QFN56, silicon revision v0.2, 2 ядра Xtensa LX7 @ 240 МГц)
- **Фактический размер Flash:** **16 МБ (16 777 216 байт)**, режим Quad I/O (QIO), 80 МГц
- **Фактический размер PSRAM:** **8 МБ (8 388 608 байт)**, режим Octal SPI (OPI)
- **Свободно PSRAM при старте:** 8 384 052 байт
- **Свободно Heap при старте:** 341 260 байт (333.26 КБ)
- **USB-UART интерфейс:** WCH CH340 (`VID: 0x1A86, PID: 0x7523`, порт COM9)
- **Версии ПО:**
  - Arduino-ESP32 Core: **3.2.1**
  - ESP-IDF: **v5.4.2-25-g858a988d6e**
  - FQBN сборки: `esp32:esp32:esp32s3:FlashSize=16M,FlashMode=qio,PSRAM=opi,CDCOnBoot=default,UploadMode=default`

---

## 2. Подтверждённая распиновка оборудования (Этап 1)

### A. Датчик BME280 (I²C) — ПОДТВЕРЖДЕНО:
| Сигнал | Назначенный GPIO | Статус | Комментарий |
|---|---|---|---|
| **SDA** | **GPIO 1** | **ПОДТВЕРЖДЕНО НА УСТРОЙСТВЕ** | Свободный пин гребёнки |
| **SCL** | **GPIO 2** | **ПОДТВЕРЖДЕНО НА УСТРОЙСТВЕ** | Свободный пин гребёнки |
| VCC | 3V3 | Подтверждено | Питание 3.3 В |
| GND | GND | Подтверждено | Общий провод |
| I²C Адрес | `0x76` | **ПОДТВЕРЖДЕНО** | Сканирование I²C |
| Chip ID | `0x60` | **ПОДТВЕРЖДЕНО** | Подлинный BME280 (T + H + P) |

### B. Камера на шлейфе FPC/FFC (DVP 8-bit) — ПОДТВЕРЖДЕНО:
| Линия DVP | Назначенный GPIO | Статус | Назначение |
|---|---|---|---|
| XCLK | **15** | **ПОДТВЕРЖДЕНО** | Внешняя тактовая частота (20 МГц) |
| PCLK | **13** | **ПОДТВЕРЖДЕНО** | Pixel Clock |
| VSYNC | **6** | **ПОДТВЕРЖДЕНО** | Кадровая синхронизация |
| HREF | **7** | **ПОДТВЕРЖДЕНО** | Строчная синхронизация |
| SIOD (SDA) | **4** | **ПОДТВЕРЖДЕНО** | SCCB шина данных (сенсор на `0x30`) |
| SIOC (SCL) | **5** | **ПОДТВЕРЖДЕНО** | SCCB шина тактирования |
| Y2 (D0) | **11** | **ПОДТВЕРЖДЕНО** | Линия данных 0 |
| Y3 (D1) | **9** | **ПОДТВЕРЖДЕНО** | Линия данных 1 |
| Y4 (D2) | **8** | **ПОДТВЕРЖДЕНО** | Линия данных 2 |
| Y5 (D3) | **10** | **ПОДТВЕРЖДЕНО** | Линия данных 3 |
| Y6 (D4) | **12** | **ПОДТВЕРЖДЕНО** | Линия данных 4 |
| Y7 (D5) | **18** | **ПОДТВЕРЖДЕНО** | Линия данных 5 |
| Y8 (D6) | **17** | **ПОДТВЕРЖДЕНО** | Линия данных 6 (Внимание: НЕ использовать для I2C!) |
| Y9 (D7) | **16** | **ПОДТВЕРЖДЕНО** | Линия данных 7 (Внимание: НЕ использовать для I2C!) |
| PWDN | **-1** | Подтверждено | Подтянут к GND |
| RESET | **-1** | Подтверждено | Программный сброс через SCCB |

> [!CAUTION]
> **Причина сбоя на GPIO 16 и 17:** Линии GPIO 16 и 17 являются аппаратными линиями параллельного видеоинтерфейса камеры DVP (Y9 и Y8). Подключение к ним датчиков I²C приводит к аппаратному конфликту и сбою шины при старте камеры. Для любых периферийных I²C датчиков на этой плате необходимо использовать **GPIO 1 (SDA) и GPIO 2 (SCL)**.

---

## 3. Результаты проверки камеры OV2640 (Этап C)

- **Драйвер:** `esp_camera.h` (DVP, НЕ UVC/USB)
- **Сенсор определён:** **OV2640 (2 Megapixel DVP)**
  - `PID = 0x0026`, `MIDH = 0x7F`, `MIDL = 0xA2`, `VER = 0x42`
- **Разрешение:** QVGA (320×240) JPEG
- **Буфер кадра:** 2 буфера в **Octal PSRAM** (`fb_location = CAMERA_FB_IN_PSRAM`)
- **Валидация каждого кадра:** Сигнатура JPEG Magic Bytes `0xFF 0xD8` — **PASS**.

---

## 4. Результаты одновременной совместной работы (Этап D)

В ходе 115-секундного теста на реальной плате:
1. Датчик BME280 непрерывно опрашивался каждые 5 секунд.
2. Камера параллельно выполнила **10 последовательных снимков** JPEG.
3. Опрос датчика BME280 **не прерывался ни на секунду** во время съёмки кадров.
4. Значения свободной памяти (`Free Heap: 319564`, `Free PSRAM: 8350644`) оставались **абсолютно неизменными** на протяжении всех 10 снимков — **0 байт утечки памяти**.
5. Не произошло ни одной циклической перезагрузки или зависания.

### Фрагмент реального лога Stage D с устройства:
```text
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #1: OK | 7133 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #2: OK | 7133 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #3: OK | 6466 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #4: OK | 6438 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #5: OK | 6463 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #6: OK | 6463 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #7: OK | 6463 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #8: OK | 6130 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #9: OK | 6131 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[BME280] Temperature: 24.6 C
[BME280] Humidity: 82.0 %
[BME280] Pressure: 687.5 hPa
[CAMERA] Shot #10: OK | 6131 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644

*******************************************************
[STAGE D COMPLETE] Successfully captured 10 consecutive frames!
```

---

## 5. Вывод по критериям завершения первого этапа

| Критерий | Требование | Фактический результат | Статус |
|---|---|---|---|
| 1 | Плата стабильно запускается | Запуск без сбоев, CH340 COM9 115200 | **ВЫПОЛНЕНО** |
| 2 | BME280 регулярно выдаёт реальные показания | Опрос каждые 5 с: T=24.6 °C, H=82.0%, P=687.5 hPa | **ВЫПОЛНЕНО** |
| 3 | Камера успешно создаёт JPEG | QVGA JPEG с валидным маркером `0xFF 0xD8` | **ВЫПОЛНЕНО** |
| 4 | Получено не менее 10 последовательных снимков | Ровно 10 снимков получено без ребутов | **ВЫПОЛНЕНО** |
| 5 | Датчик продолжает работать во время съёмки | BME280 отдаёт данные в параллели со съёмкой | **ВЫПОЛНЕНО** |
| 6 | Нет циклических перезагрузок или утечек буферов | Дельта Heap и PSRAM за 10 снимков = 0 байт | **ВЫПОЛНЕНО** |
| 7 | Все подтверждения и ошибки отражены в отчёте | Полный отчёт сохранён в README.md | **ВЫПОЛНЕНО** |

**Первый этап проверки полностью завершён.** Аппаратная платформа, шлейфовая камера OV2640 и датчик BME280 на GPIO 1 и 2 полностью подтверждены на реальном железе.
