#!/usr/bin/env bash
# BrowseFleet Cloudflare Tunnel Setup Script
# This script configures cloudflared to properly proxy WebSocket connections
# for the CDP endpoint (/cdp/*) through to BrowseFleet on port 3000.
#
# It works with the existing host-level cloudflared systemd service that
# already manages multiple ingress rules in /etc/cloudflared/config.yml.
#
# Usage:
#   sudo ./scripts/setup-cloudflare-tunnel.sh
#   # Or with custom hostname:
#   sudo BROWSEFLEET_HOST=browsefleet.yourdomain.com ./scripts/setup-cloudflare-tunnel.sh
#
# Prerequisites:
#   - cloudflared installed and authenticated (cloudflared tunnel login)
#   - BrowseFleet running on localhost:3000 (or custom port via BROWSEFLEET_PORT)
#   - DNS record for the hostname pointing to the tunnel (cloudflared tunnel route dns)

set -euo pipefail

CONFIG_FILE="/etc/cloudflared/config.yml"
BROWSEFLEET_HOST="${BROWSEFLEET_HOST:-browsefleet.ishanparihar.com}"
BROWSEFLEET_PORT="${BROWSEFLEET_PORT:-3000}"
BROWSEFLEET_SCHEME="${BROWSEFLEET_SCHEME:-http}"  # http inside the tunnel

echo "BrowseFleet Cloudflare Tunnel Setup"
echo "===================================="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root (use sudo)" >&2
  exit 1
fi

# Check if cloudflared is installed
if ! command -v cloudflared &>/dev/null; then
  echo "Error: cloudflared is not installed" >&2
  echo "Install with: curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null && echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared \$(lsb_release -cs) main' | tee /etc/apt/sources.list.d/cloudflared.list && apt update && apt install -y cloudflared" >&2
  exit 1
fi

# Check if BrowseFleet is running locally
if ! curl -s "http://localhost:${BROWSEFLEET_PORT}/health" &>/dev/null; then
  echo "Warning: BrowseFleet does not appear to be running on port ${BROWSEFLEET_PORT}" >&2
  echo "Please start BrowseFleet (docker compose up -d) before continuing" >&2
  read -p "Continue anyway? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

# Backup existing config
if [ -f "$CONFIG_FILE" ]; then
  cp "$CONFIG_FILE" "${CONFIG_FILE}.backup.$(date +%Y%m%d%H%M%S)"
  echo "Backed up existing config to ${CONFIG_FILE}.backup.*"
fi

# Read the entire config into a variable
config_content=$(cat "$CONFIG_FILE")

# Check if browsefleet entry already exists (look for the hostname in ingress)
if echo "$config_content" | grep -q "hostname: ${BROWSEFLEET_HOST}"; then
  echo "Found existing entry for ${BROWSEFLEET_HOST} — updating to enable WebSocket support..."
  
  # Use awk to replace the entire ingress rule block for this hostname
  # This is more reliable than sed for multi-line YAML replacement
  awk -v host="${BROWSEFLEET_HOST}" -v port="${BROWSEFLEET_PORT}" -v scheme="${BROWSEFLEET_SCHEME}" '
    BEGIN { in_block=0; printed=0; skip=0 }
    /^ingress:/ { print; in_block=1; next }
    in_block && /^  - hostname: / {
      if ($3 == host) {
        skip=1
        # Print the new rule
        printf "  - hostname: %s\n", host
        printf "    service: %s://127.0.0.1:%s\n", scheme, port
        printf "    originRequest:\n"
        printf "      noTLSVerify: true\n"
        printf "      connectTimeout: 30s\n"
        printed=1
      } else {
        skip=0
      }
    }
    skip && /^    / { next }  # skip old rule lines
    skip && !/^    / { skip=0 }  # end of rule
    !skip { print }
    END { 
      if (!printed && in_block) {
        # No existing rule found, append at end of ingress (before catch-all)
        # This case is handled by the main script below
      }
    }
  ' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
else
  echo "No existing entry for ${BROWSEFLEET_HOST} — adding new ingress rule with WebSocket support..."
  
  # Insert the new rule before the catch-all (last rule: service: http_status:404)
  # Use awk to find the catch-all and insert before it
  awk -v host="${BROWSEFLEET_HOST}" -v port="${BROWSEFLEET_PORT}" -v scheme="${BROWSEFLEET_SCHEME}" '
    /^  - service: http_status:404/ && !inserted {
      printf "  - hostname: %s\n", host
      printf "    service: %s://127.0.0.1:%s\n", scheme, port
      printf "    originRequest:\n"
      printf "      noTLSVerify: true\n"
      printf "      connectTimeout: 30s\n"
      printf "\n"
      inserted=1
    }
    { print }
  ' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp" && mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
fi

echo ""
echo "Configuration updated. Verifying..."
echo ""

# Show the relevant section
grep -A 6 "hostname: ${BROWSEFLEET_HOST}" "$CONFIG_FILE" || echo "WARNING: Entry not found after update!"

echo ""
echo "Restarting cloudflared..."

# Restart cloudflared
systemctl restart cloudflared

# Wait a moment for it to come up
sleep 2

# Check status
if systemctl is-active --quiet cloudflared; then
  echo ""
  echo "✓ cloudflared restarted successfully"
else
  echo ""
  echo "✗ cloudflared failed to restart. Check logs with: journalctl -u cloudflared -n 50"
  exit 1
fi

echo ""
echo "Setup complete! WebSocket connections should now work."
echo ""
echo "Test the public HTTPS endpoint:"
echo "  curl -H 'x-api-key: <key>' https://${BROWSEFLEET_HOST}/health"
echo ""
echo "Test WebSocket upgrade (CDP proxy):"
echo "  curl -H 'Connection: Upgrade' -H 'Upgrade: websocket' \\"
echo "       -H 'Sec-WebSocket-Version: 13' \\"
echo "       -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \\"
echo "       https://${BROWSEFLEET_HOST}/cdp/test"
echo ""
echo "Or use the CLI from a remote host:"
echo "  export BROWSEFLEET_URL=https://${BROWSEFLEET_HOST}"
echo "  export BROWSEFLEET_TOKEN=<your-api-key>"
echo "  bf session create"