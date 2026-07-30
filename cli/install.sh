#!/usr/bin/env bash
# bf — BrowseFleet CLI installer
#
# Install on any host where an AI agent (or a developer) needs to talk to a
# BrowseFleet instance. Two install paths:
#
#   1. One-liner via curl (works against any self-hosted BrowseFleet repo):
#        curl -fsSL https://raw.githubusercontent.com/<owner>/browsefleet/master/cli/install.sh | bash -s -- <bf-url> <bf-token>
#        # example:
#        curl -fsSL https://raw.githubusercontent.com/ishan-parihar/browsefleet/master/cli/install.sh | \
#          bash -s -- https://browsefleet.ishanparihar.com <api-key>
#
#   2. From a local clone (this directory):
#        ./cli/install.sh [bf-url] [bf-token]
#        ./cli/install.sh                                  # interactive prompts
#        PREFIX=/usr/local/bin ./cli/install.sh <url> <key> # system-wide install
#
# After install:
#        bf health
#        bf session create
#        bf axi <sid> open https://example.com
#
# Configuration lives in the user's shell rc, not in the CLI binary:
#        export BROWSEFLEET_URL=https://your-browsefleet-host
#        export BROWSEFLEET_TOKEN=your-api-key
#        export BROWSEFLEET_CDP_URL=https://your-browsefleet-host   # optional rewrite
#
# Set both env vars and run `bf health`. The CLI does not phone home.

set -euo pipefail

REPO="${BF_REPO:-ishan-parihar/browsefleet}"
REF="${BF_REF:-master}"
PREFIX="${PREFIX:-$HOME/.local/bin}"
BF_URL="${1:-${BROWSEFLEET_URL:-}}"
BF_TOKEN="${2:-${BROWSEFLEET_TOKEN:-}}"

# Detect install mode: local file present means we are running from a clone.
LOCAL_BF="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/bf"

install_from_local() {
  install -d "$PREFIX"
  install -m 0755 "$LOCAL_BF" "$PREFIX/bf"
}

install_from_remote() {
  install -d "$PREFIX"
  local url="https://raw.githubusercontent.com/${REPO}/${REF}/cli/bf"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$PREFIX/bf"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$PREFIX/bf" "$url"
  else
    echo "install: need curl or wget" >&2
    exit 1
  fi
  chmod 0755 "$PREFIX/bf"
}

# Pick source.
if [ -f "$LOCAL_BF" ]; then
  install_from_local
  src="local clone"
else
  install_from_remote
  src="https://raw.githubusercontent.com/${REPO}/${REF}/cli/bf"
fi

# Prompt for URL/token if missing (TTY only).
if [ -t 1 ] && [ -z "$BF_URL" ]; then
  printf 'BrowseFleet URL (e.g. https://browsefleet.example.com): ' >&2
  read -r BF_URL || BF_URL=""
fi
if [ -t 1 ] && [ -z "$BF_TOKEN" ]; then
  printf 'API key (leave blank if auth is disabled): ' >&2
  read -rs BF_TOKEN || BF_TOKEN=""
  printf '\n' >&2
fi

# Persist config via shell rc so future shells see it without re-exporting.
write_rc_line() {
  local rc="$1" line="$2"
  [ -f "$rc" ] || return 0
  grep -Fqx "$line" "$rc" 2>/dev/null && return 0
  printf '\n%s\n' "$line" >> "$rc"
}

if [ -n "$BF_URL" ]; then
  case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *) printf '\nexport PATH="%s:$PATH"\n' "$PREFIX" ;;
  esac
  printf '\n# BrowseFleet CLI\n' >&2
  printf 'installed: %s/bf (from %s)\n' "$PREFIX" "$src" >&2
  printf 'configure: export BROWSEFLEET_URL=%s\n' "$BF_URL" >&2
  [ -n "$BF_TOKEN" ] && printf 'configure: export BROWSEFLEET_TOKEN=%s\n' "$BF_TOKEN" >&2
  printf 'test:     %s/bf health\n' "$PREFIX" >&2

  for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
    [ -f "$rc" ] || continue
    write_rc_line "$rc" "export BROWSEFLEET_URL=\"$BF_URL\""
    [ -n "$BF_TOKEN" ] && write_rc_line "$rc" "export BROWSEFLEET_TOKEN=\"$BF_TOKEN\""
  done
fi
