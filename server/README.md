# Growbox Server Infrastructure (VPS Deployment)

## Требования на VPS
- Установленный Docker и Docker Compose (`docker --version`, `docker compose version`)

## Развертывание на VPS (1 команда!)

1. Скопируйте папку `server/` на ваш VPS:
   ```bash
   scp -r server/ user@YOUR_VPS_IP:/home/user/growbox-server/
   ```
   *(или через git clone, FileZilla / WinSCP)*

2. Зайдите на VPS и перейдите в папку:
   ```bash
   cd /home/user/growbox-server
   ```

3. Запустите всё в Docker:
   ```bash
   docker compose up -d --build
   ```

Docker автоматически:
- Скачает и запустит **Mosquitto** (порты 1883 для ESP32 и 9001 WebSockets для браузера)
- Скачает и настроит **InfluxDB** (порт 8086 для временных рядов сенсоров)
- Соберёт и запустит **Node.js Bridge** (порт 3001, конвертация YUY2→JPEG и запись в БД)
- Соберёт внутри контейнера React и запустит веб-дашборд на **Nginx** (порт 80)

## Проверка работы

- **Веб-дашборд:** Откройте в браузере `http://YOUR_VPS_IP`
- **Проверка MQTT сообщений:**
  ```bash
  docker exec -it growbox_mosquitto mosquitto_sub -t "growbox/#" -v
  ```
- **Проверка логов bridge:**
  ```bash
  docker logs -f growbox_bridge
  ```
- **Проверка здоровья bridge API:**
  ```bash
  curl http://localhost:3001/health
  ```
