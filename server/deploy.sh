#!/bin/bash
set -e

echo "=========================================="
echo "      GROWBOX IOT SERVER DEPLOYMENT       "
echo "=========================================="

# 1. Check Docker & Docker Compose
if ! command -v docker &> /dev/null; then
    echo "[-] Docker is not installed. Installing Docker..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker $USER
    echo "[+] Docker installed successfully!"
fi

# 2. Setup .env file
if [ ! -f .env ]; then
    echo "[+] Creating .env from .env.example..."
    cp .env.example .env
fi

# 3. Create images directory and set permissions
mkdir -p bridge/images
chmod 777 bridge/images

# 4. Pull and Start Services
echo "[+] Starting Docker containers..."
docker compose pull
docker compose build bridge
docker compose up -d

echo ""
echo "=========================================="
echo "    GROWBOX SERVER STARTED SUCCESSFULLY!  "
echo "=========================================="
echo "Web Dashboard:  http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_VPS_IP'):80"
echo "MQTT Broker:    Port 1883 (for ESP32)"
echo "InfluxDB UI:    http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_VPS_IP'):8086"
echo ""
echo "Firewall reminder (if UFW enabled):"
echo "  sudo ufw allow 22/tcp"
echo "  sudo ufw allow 80/tcp"
echo "  sudo ufw allow 1883/tcp"
echo "=========================================="