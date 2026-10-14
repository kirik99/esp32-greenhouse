# Отчёт и руководство: Диагностика HZAD ESP32-S3 WROOM N16R8 CAM (Этап 1)

## 1. Аппаратная платформа и конфигурация сборки

Все параметры подтверждены реальными вызовами API прошивки и инструментами прошивки:
- **Плата / Модуль:** ESP32-S3-WROOM-1 (N16R8)
- **Модель чипа:** ESP32-S3 (QFN56, silicon revision v0.2, 2 ядра, 240 МГц)
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

## 2. Результаты проверки камеры на FPC/FFC-шлейфе (Этап C)

- **Драйвер:** `esp_camera.h` (параллельный 8-битный DVP интерфейс через DMA)
- **Определённая модель сенсора:** **OV2640 (2 Megapixel DVP)**
  - Регистры сенсора: `PID = 0x0026`, `MIDH = 0x7F`, `MIDL = 0xA2`, `VER = 0x42`
- **Буферы кадра:** Выделены в **Octal PSRAM** (`fb_location = CAMERA_FB_IN_PSRAM`, `fb_count = 2`)
- **Разрешение тестовых снимков:** QVGA (320×240), формат JPEG
- **Валидация JPEG:** **PASS** (проверена сигнатура Magic Bytes: `0xFF 0xD8` в начале каждого кадра)
- **Тест повторной съёмки:** Выполнено **10 последовательных снимков** без перезагрузки платы.
- **Проверка утечек памяти:**
  - `Free Heap` до и после 10 снимков: строго **319 564 байт** (дельта = 0).
  - `Free PSRAM` до и после 10 снимков: строго **8 350 644 байт** (дельта = 0).
  - **Утечек памяти нет.**

### Подтверждённые GPIO камеры (Профиль `CAM_PROFILE_S3_STANDARD`):
| Линия DVP | GPIO | Статус | Назначение |
|---|---|---|---|
| XCLK | **15** | Подтверждено | Внешняя тактовая частота (20 МГц) |
| PCLK | **13** | Подтверждено | Pixel Clock |
| VSYNC | **6** | Подтверждено | Кадровая синхронизация |
| HREF | **7** | Подтверждено | Строчная синхронизация |
| SIOD (SDA) | **4** | Подтверждено | SCCB шина данных (сенсор отвечает на 0x30) |
| SIOC (SCL) | **5** | Подтверждено | SCCB шина тактирования |
| Y2 (D0) | **11** | Подтверждено | Линия данных 0 |
| Y3 (D1) | **9** | Подтверждено | Линия данных 1 |
| Y4 (D2) | **8** | Подтверждено | Линия данных 2 |
| Y5 (D3) | **10** | Подтверждено | Линия данных 3 |
| Y6 (D4) | **12** | Подтверждено | Линия данных 4 |
| Y7 (D5) | **18** | Подтверждено | Линия данных 5 |
| Y8 (D6) | **17** | Подтверждено | Линия данных 6 (Внимание: конфликт с пином 17) |
| Y9 (D7) | **16** | Подтверждено | Линия данных 7 (Внимание: конфликт с пином 16) |
| PWDN | **-1** | Подтверждено | Подтянут к GND |
| RESET | **-1** | Подтверждено | Программный сброс через SCCB |

---

## 3. Результаты проверки BME280 и аппаратный конфликт GPIO (Этап B и D)

### Анализ подключения к GPIO 16 и 17:
При сканировании альтернативных пар пинов на паре `SDA = GPIO 17`, `SCL = GPIO 16`:
1. Датчик был обнаружен по адресу `0x76`.
2. Регистр Chip ID считан как `0x60`, что однозначно подтверждает **подлинный BME280** (а не BMP280 `0x58`).
3. Было получено физическое показание температуры: `24.64 °C`.
4. **НО**: как только драйвер камеры `esp_camera` инициализируется, линии **GPIO 16 и 17 захватываются как старшие биты шины данных DVP (Y9 и Y8)**.
5. Из-за этого при совместной работе передача пикселей камеры вызывает аппаратный NACK на шине I²C, а с датчика начинают считываться мусорные данные (`T = -141.17 °C`).

> [!CAUTION]
> **GPIO 16 и 17 НЕЛЬЗЯ использовать для BME280 при подключённой камере!**
> Пины 16 и 17 аппаратно разведены на шлейф камеры FPC/FFC как биты данных Y9 и Y8.

### Рекомендованное решение:
Переподключить 2 провода I²C датчика BME280 на свободные пины колодки:
- **Вариант 1 (Рекомендуемый):** 
  - `SDA` -> **GPIO 1**
  - `SCL` -> **GPIO 2**
- **Вариант 2 (Общая шина I²C с камерой):**
  - `SDA` -> **GPIO 4**
  - `SCL` -> **GPIO 5**
  *(Камера занимает на этой шине адрес `0x30`, а BME280 — `0x76`, адреса не пересекаются).*

---

## 4. Лог 10 последовательных снимков камеры (Этап D)

```text
[CAMERA] Shot #1:  OK | 6131 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #2:  OK | 6131 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #3:  OK | 6050 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #4:  OK | 7102 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #5:  OK | 7102 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #6:  OK | 6119 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #7:  OK | 6131 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #8:  OK | 6133 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #9:  OK | 6132 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[CAMERA] Shot #10: OK | 6132 bytes | Resolution: 320x240 | Valid JPEG: YES | Free Heap: 319564 | Free PSRAM: 8350644
[STAGE D COMPLETE] Successfully captured 10 consecutive frames!
```

---

## 5. Как собрать и запустить диагностический скетч

Скетч расположен в каталоге `hzad_s3_cam_diag/`.

1. Команда компиляции:
```powershell
& "C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,FlashMode=qio,PSRAM=opi,CDCOnBoot=default,UploadMode=default" "C:\Users\kirik\OneDrive\Documents\Arduino\hzad_s3_cam_diag"
```

2. Команда прошивки:
```powershell
& "C:\Program Files\Arduino IDE\resources\app\lib\backend\resources\arduino-cli.exe" upload -p COM9 --fqbn "esp32:esp32:esp32s3:FlashSize=16M,FlashMode=qio,PSRAM=opi,CDCOnBoot=default,UploadMode=default" "C:\Users\kirik\OneDrive\Documents\Arduino\hzad_s3_cam_diag"
```
