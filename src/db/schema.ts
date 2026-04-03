import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logger } from '../server.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = `${config.dataDir}/browsefleet.db`;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info({ path: dbPath }, 'Database initialized');

  return db;
}

function runMigrations(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      max_concurrent_sessions INTEGER DEFAULT 30,
      max_session_duration INTEGER DEFAULT 1800000,
      rate_limit_per_second INTEGER DEFAULT 10,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      stripe_subscription_item_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      api_key TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      released_at TEXT,
      duration_ms INTEGER,
      browser_hours REAL,
      proxy_url TEXT,
      stealth_level TEXT,
      viewport_width INTEGER,
      viewport_height INTEGER,
      profile_id TEXT,
      error_message TEXT,
      FOREIGN KEY (api_key) REFERENCES api_keys(key)
    );

    CREATE TABLE IF NOT EXISTS api_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER,
      duration_ms INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      api_key TEXT NOT NULL,
      date TEXT NOT NULL,
      sessions_created INTEGER DEFAULT 0,
      browser_hours REAL DEFAULT 0,
      api_calls INTEGER DEFAULT 0,
      PRIMARY KEY (api_key, date)
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      api_key TEXT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_api_key ON sessions(api_key);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_api_calls_key_created ON api_calls(api_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(date);
    CREATE INDEX IF NOT EXISTS idx_api_keys_stripe_customer ON api_keys(stripe_customer_id);
  `);

  // Add Stripe columns to existing api_keys tables (safe to re-run)
  const cols = db.pragma('table_info(api_keys)') as Array<{ name: string }>;
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('stripe_customer_id')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN stripe_customer_id TEXT');
  }
  if (!colNames.has('stripe_subscription_id')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN stripe_subscription_id TEXT');
  }
  if (!colNames.has('stripe_subscription_item_id')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN stripe_subscription_item_id TEXT');
  }
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
