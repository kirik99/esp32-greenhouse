#!/bin/bash
set -e

ENABLE_HTTPS=false
if [ "${1:-}" = "--https" ]; then
    ENABLE_HTTPS=true
elif [ "$#" -gt 0 ]; then
    echo "Usage: $0 [--https]"
    exit 2
fi

COMPOSE_FILES=(-f docker-compose.yml)

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

# 3. Setup Mosquitto credentials
if [ ! -f mosquitto/passwords.txt ]; then
    echo "[+] Initializing mosquitto/passwords.txt from example..."
    cp mosquitto/passwords.txt.example mosquitto/passwords.txt
    chmod 644 mosquitto/passwords.txt
fi

# 4. Create runtime directories
mkdir -p bridge/images
chmod 777 bridge/images

# 4. Optionally enable direct HTTPS with a self-signed certificate
if [ "$ENABLE_HTTPS" = true ]; then
    mkdir -p nginx/certs
    if [ ! -f nginx/certs/cert.pem ] || [ ! -f nginx/certs/key.pem ]; then
        echo "[+] Generating self-signed SSL certificate for direct HTTPS access..."
        if ! command -v openssl &> /dev/null; then
            echo "[-] OpenSSL is required when --https is enabled."
            exit 1
        fi
        openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
            -keyout nginx/certs/key.pem \
            -out nginx/certs/cert.pem \
            -subj "/CN=growbox"
    fi
    COMPOSE_FILES+=(-f docker-compose.https.yml)
fi

# 5. Build and Start Services
echo "[+] Starting Docker containers..."
docker compose "${COMPOSE_FILES[@]}" build bridge
docker compose "${COMPOSE_FILES[@]}" up -d

echo ""
echo "=========================================="
echo "    GROWBOX SERVER STARTED SUCCESSFULLY!  "
echo "=========================================="
if [ "$ENABLE_HTTPS" = true ]; then
    echo "Web Dashboard:  https://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP') (Port ${SSL_PORT:-443})"
else
    echo "Web Dashboard:  http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_SERVER_IP') (Port ${WEB_PORT:-80})"
fi
echo "MQTT Broker:    Port 1883 (for ESP32 on local Wi-Fi)"
echo ""
echo "External access (Router / Firewall):"
if [ "$ENABLE_HTTPS" = true ]; then
    echo "  Direct self-signed HTTPS is enabled."
else
    echo "  Put an HTTPS reverse proxy in front of port 80 for external access,"
    echo "  or rerun this script with --https for direct self-signed HTTPS."
fi
echo "=========================================="
