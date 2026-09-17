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

# 3. Create images and certs directories
mkdir -p bridge/images
chmod 777 bridge/images
mkdir -p nginx/certs

# 4. Generate SSL certificate if missing
if [ ! -f nginx/certs/cert.pem ]; then
    echo "[+] Generating self-signed SSL certificates for HTTPS (port 443)..."
    if command -v openssl &> /dev/null; then
        openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -keyout nginx/certs/key.pem -out nginx/certs/cert.pem -subj "/CN=growbox"
    fi
fi

# 5. Build and Start Services
echo "[+] Starting Docker containers..."
docker compose build bridge
docker compose up -d

echo ""
echo "=========================================="
echo "    GROWBOX SERVER STARTED SUCCESSFULLY!  "
echo "=========================================="
echo "Web Dashboard:  https://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP') (Port 443 / 80)"
echo "MQTT Broker:    Port 1883 (for ESP32 on local Wi-Fi)"
echo ""
echo "External access (Router / Firewall):"
echo "  Only ports 80 (HTTP) and 443 (HTTPS/WSS) need to be forwarded!"
echo "=========================================="