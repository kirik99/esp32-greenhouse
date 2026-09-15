# Growbox Server Infrastructure (Docker / VPS)

Готовая серверная инфраструктура для Growbox IoT системы. Работает как локально (Docker Desktop / WSL), так и на любом удалённом сервере (VPS на Ubuntu / Debian / CentOS).

## Архитектура сервисов

```
[ ESP32-S3 ] (Wi-Fi)
     |
     +---> [ Mosquitto MQTT:1883 ] <---+
     |                                 |
     |                              [ Bridge ] (Node.js)
     |                                 |
     |                                 +---> [ InfluxDB:8086 ]
     |                                 +---> [ images/*.jpg ]
     v                                 |
[ Nginx Proxy :80 ] <------------------+
     |
     +---> [ Web Dashboard UI :80 ]
     +---> [ /api/* Proxy -> Bridge:3001 ]
     +---> [ /mqtt Proxy -> Mosquitto:9001 (WebSockets) ]
```

---

## Развертывание на VPS за 3 шага

### Шаг 1. Склонировать репозиторий на VPS
```bash
git clone https://github.com/kirik99/esp32-greenhouse.git
cd esp32-greenhouse/server
```

### Шаг 2. Запустить автоустановку
```bash
chmod +x deploy.sh
./deploy.sh
```
*Скрипт сам проверит Docker, создаст `.env` конфиг, выставит права на папки и поднимет все 4 контейнера.*

### Шаг 3. Настройка фаервола VPS (если включен UFW)
```bash
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # Web Dashboard & API
sudo ufw allow 1883/tcp   # MQTT Broker (для ESP32)
```

---

## Настройка ESP32 для подключения к VPS

В файле прошивки `growbox/wifi_config.h` укажите внешний IP вашего VPS:
```cpp
#define WIFI_SSID "your_home_wifi"
#define WIFI_PASSWORD "your_password"
#define MQTT_HOST "YOUR_VPS_PUBLIC_IP"   // Например, "185.123.45.67"
#define MQTT_PORT 1883
```

---

## Конфигурация (.env)
Все параметры можно настроить в файле `.env`:
* `TZ` — часовой пояс (по умолчанию `Europe/Moscow`)
* `INFLUXDB_USER` / `INFLUXDB_PASSWORD` — логин и пароль в базу данных
* `INFLUXDB_TOKEN` — токен доступа к API InfluxDB
* `WEB_PORT` — порт веб-интерфейса (по умолчанию `80`)

---

## Полезные команды

* **Статус контейнеров:** `docker compose ps`
* **Логи моста (приём фото и датчиков):** `docker logs -f growbox_bridge`
* **Логи MQTT брокера:** `docker logs -f growbox_mosquitto`
* **Прослушать топики в реальном времени:**
  ```bash
  docker exec -it growbox_mosquitto mosquitto_sub -t "growbox/#" -v
  ```
* **Перезапустить всё:** `docker compose restart`