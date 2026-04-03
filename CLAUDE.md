# BrowseFleet — Cloud Browser API

Open-source headless browser API for AI agents and automation. Competing with Steel.dev.

## Quick Start

```bash
npm install
npm run dev          # Development with hot reload
# or
docker-compose up    # Production with Docker
```

## Architecture

Single Node.js process managing Chrome child processes via puppeteer-core/puppeteer-extra.

- **Hono** REST API on port 3000
- **WebSocket** CDP proxy on the same port (`/cdp/:sessionId`)
- **SQLite** (better-sqlite3) for usage tracking + API keys
- **puppeteer-extra + stealth** for anti-detection

## Key Directories

- `src/pool/` — BrowserPool + BrowserSession (Chrome lifecycle management)
- `src/proxy/` — CDP WebSocket proxy (transparent, bidirectional)
- `src/routes/` — All API endpoints
- `src/extract/` — HTML → markdown/readability content extraction
- `src/stealth/` — Anti-detection configuration
- `src/db/` — SQLite schema + usage tracking

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/v1/sessions` | Create browser session |
| GET | `/v1/sessions` | List active sessions |
| GET | `/v1/sessions/:id` | Get session details |
| POST | `/v1/sessions/:id/release` | Release session |
| POST | `/v1/sessions/release` | Release all/batch |
| WS | `/cdp/:sessionId` | CDP WebSocket proxy |
| POST | `/v1/scrape` | Scrape URL → HTML/markdown/text |
| POST | `/v1/screenshot` | Screenshot URL → PNG/JPEG |
| POST | `/v1/pdf` | PDF from URL |
| POST | `/v1/sessions/:id/actions` | Computer API (click/type/scroll) |
| POST | `/v1/sessions/:id/captcha/solve` | Solve CAPTCHA via 2captcha |
| CRUD | `/v1/profiles` | Browser profile management |
| POST | `/v1/sessions/:id/files` | Upload file to session |
| GET | `/v1/sessions/:id/files/:name` | Download file from session |
| GET | `/v1/sessions/:id/live` | SSE live session viewer |
| GET | `/v1/usage` | Usage statistics |

## Environment Variables

See `.env.example` for all options. Key ones:
- `API_KEYS` — comma-separated API keys (empty = no auth)
- `MAX_CONCURRENT_SESSIONS` — default 30
- `STEALTH_DEFAULT` — none/basic/full (default: full)
- `CHROME_PATH` — path to Chrome/Chromium binary
- `CAPTCHA_API_KEY` — 2captcha API key for CAPTCHA solving
- `PROXY_URL` — global proxy URL

## Testing

```bash
# Health check
curl localhost:3000/health

# Create session
curl -X POST localhost:3000/v1/sessions -H 'Content-Type: application/json'

# Scrape
curl -X POST localhost:3000/v1/scrape -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'

# Screenshot
curl -X POST localhost:3000/v1/screenshot -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' --output screenshot.png
```

## Domain

browsefleet.com
