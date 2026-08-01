#!/usr/bin/env bash
# BrowseFleet Fresh Install Bootstrap
# Run this on a fresh Ubuntu/Debian server to set up everything:
#   - Docker + Docker Compose
#   - BrowseFleet (via docker compose)
#   - Cloudflare tunnel (host-level systemd service)
#   - DNS record for your domain
#
# Usage:
#   sudo ./scripts/bootstrap-fresh-install.sh [hostname]
#   # Example:
#   sudo ./scripts/bootstrap-fresh-install.sh browsefleet.yourdomain.com
#
# Prerequisites:
#   - A domain name pointed to this server's IP (A/AAAA record)
#   - Cloudflare account (for tunnel)
#   - Root/sudo access

set -euo pipefail

BROWSEFLEET_HOST="${1:-browsefleet.ishanparihar.com}"
REPO_DIR="/opt/browsefleet"
GITHUB_REPO="https://github.com/ishan-parihar/browsefleet.git"

echo "BrowseFleet Fresh Install Bootstrap"
echo "===================================="
echo "Hostname: ${BROWSEFLEET_HOST}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root (use sudo)" >&2
  exit 1
fi

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS_ID="$ID"
  OS_VERSION="$VERSION_ID"
else
  echo "Error: Cannot detect OS" >&2
  exit 1
fi

echo "[1/8] Installing system dependencies..."
apt-get update
apt-get install -y \
  git \
  curl \
  wget \
  gnupg \
  lsb-release \
  ca-certificates \
  jq \
  docker.io \
  docker-compose-plugin

echo "[2/8] Starting Docker..."
systemctl enable --now docker

echo "[3/8] Cloning BrowseFleet..."
if [ -d "$REPO_DIR" ]; then
  echo "Directory $REPO_DIR exists, pulling latest..."
  cd "$REPO_DIR"
  git pull
else
  git clone "$GITHUB_REPO" "$REPO_DIR"
  cd "$REPO_DIR"
fi

echo "[4/8] Configuring BrowseFleet..."
if [ ! -f .env ]; then
  cp .env.example .env
fi

# Generate API keys
API_KEY_1=$(openssl rand -hex 32)
API_KEY_2=$(openssl rand -hex 32)

# Update .env with generated keys and Cloudflare config
sed -i "s/^# API_KEYS=.*/API_KEYS=${API_KEY_1},${API_KEY_2}/" .env
sed -i "s/^CDP_EXTERNAL_HOST=.*/CDP_EXTERNAL_HOST=${BROWSEFLEET_HOST}/" .env
sed -i "s/^CDP_EXTERNAL_PORT=.*/CDP_EXTERNAL_PORT=443/" .env
sed -i "s/^CDP_EXTERNAL_SCHEME=.*/CDP_EXTERNAL_SCHEME=wss/" .env

echo "Generated API keys:"
echo "  ${API_KEY_1}"
echo "  ${API_KEY_2}"
echo "Save these! They won't be shown again."

echo "[5/8] Building and starting BrowseFleet..."
docker compose up -d --build

# Wait for health
echo "Waiting for BrowseFleet to be healthy..."
for i in {1..30}; do
  if curl -s http://localhost:3000/health >/dev/null 2>&1; then
    echo "BrowseFleet is healthy!"
    break
  fi
  sleep 2
done

echo "[6/8] Installing cloudflared..."
if ! command -v cloudflared &>/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | tee /etc/apt/sources.list.d/cloudflared.list
  apt-get update
  apt-get install -y cloudflared
fi

echo "[7/8] Configuring Cloudflare tunnel..."
echo ""
echo "You need to authenticate cloudflared with your Cloudflare account:"
echo "  cloudflared tunnel login"
echo ""
echo "This will open a browser window. Select your domain (${BROWSEFLEET_HOST})."
echo ""
read -p "Press Enter after completing cloudflared tunnel login..." -r

# Create tunnel
TUNNEL_NAME="browsefleet"
if cloudflared tunnel list | grep -q "^${TUNNEL_NAME} "; then
  echo "Tunnel '${TUNNEL_NAME}' already exists"
  TUNNEL_ID=$(cloudflared tunnel list | grep "^${TUNNEL_NAME} " | awk '{print $1}')
else
  echo "Creating tunnel '${TUNNEL_NAME}'..."
  TUNNEL_ID=$(cloudflared tunnel create "${TUNNEL_NAME}" | grep -oE '[a-f0-9-]{36}' | head -1)
fi

echo "Tunnel ID: ${TUNNEL_ID}"

# Configure tunnel
CREDENTIALS_FILE="/root/.cloudflared/${TUNNEL_ID}.json"
CONFIG_FILE="/etc/cloudflared/config.yml"

cat > "${CONFIG_FILE}" << EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${CREDENTIALS_FILE}
ingress:
  - hostname: ${BROWSEFLEET_HOST}
    service: http://127.0.0.1:3000
    originRequest:
      noTLSVerify: true
      connectTimeout: 30s
      allowedIP:
        - 107.173.144.77
  - service: http_status:404
EOF

# Route DNS
echo "Routing DNS for ${BROWSEFLEET_HOST}..."
cloudflared tunnel route dns "${TUNNEL_NAME}" "${BROWSEFLEET_HOST}"

# Install and start cloudflared service
echo "[8/8] Starting cloudflared service..."
cloudflared service install
systemctl enable --now cloudflared

# Wait for cloudflared to be ready
sleep 3

if systemctl is-active --quiet cloudflared; then
  echo ""
  echo "✓ cloudflared is running"
else
  echo ""
  echo "✗ cloudflared failed to start. Check logs:"
  echo "  journalctl -u cloudflared -n 50"
  exit 1
fi

echo ""
echo "===================================="
echo "BrowseFleet installation complete!"
echo "===================================="
echo ""
echo "Public URL: https://${BROWSEFLEET_HOST}"
echo "API Keys:"
echo "  ${API_KEY_1}"
echo "  ${API_KEY_2}"
echo ""
echo "Test the deployment:"
echo "  curl -H 'x-api-key: ${API_KEY_1}' https://${BROWSEFLEET_HOST}/health"
echo "  curl -H 'x-api-key: ${API_KEY_1}' https://${BROWSEFLEET_HOST}/v1/sessions"
echo ""
echo "Install CLI on remote host:"
echo "  curl -fsSL https://raw.githubusercontent.com/ishan-parihar/browsefleet/master/cli/install.sh | bash -s -- https://${BROWSEFLEET_HOST} ${API_KEY_1}"
echo ""
echo "Configuration files:"
echo "  BrowseFleet: ${REPO_DIR}/.env"
echo "  Cloudflare:  ${CONFIG_FILE}"
echo "  Credentials: ${CREDENTIALS_FILE}"