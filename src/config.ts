import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';

dotenvConfig();

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),

  API_KEYS: z.string().default(''),

  MAX_CONCURRENT_SESSIONS: z.coerce.number().default(30),
  DEFAULT_SESSION_TIMEOUT: z.coerce.number().default(1_800_000),
  MAX_SESSION_TIMEOUT: z.coerce.number().default(86_400_000),
  CHROME_PATH: z.string().default(''),

  STEALTH_DEFAULT: z.enum(['none', 'basic', 'full']).default('full'),
  PROXY_URL: z.string().default(''),

  CAPTCHA_API_KEY: z.string().default(''),
  CAPTCHA_PROVIDER: z.enum(['2captcha', 'anticaptcha']).default('2captcha'),

  CDP_EXTERNAL_HOST: z.string().default('localhost'),
  CDP_EXTERNAL_PORT: z.coerce.number().default(3000),
  CDP_EXTERNAL_SCHEME: z.enum(['ws', 'wss']).default('ws'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  STRIPE_PRICE_ID: z.string().default(''),
  STRIPE_METER_EVENT_NAME: z.string().default('browser_hours'),

  DATA_DIR: z.string().default('./data'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  apiKeys: parsed.API_KEYS ? parsed.API_KEYS.split(',').map(k => k.trim()).filter(Boolean) : [],
  authEnabled: parsed.API_KEYS.length > 0,
  stripeEnabled: parsed.STRIPE_SECRET_KEY.length > 0,
  dataDir: path.resolve(parsed.DATA_DIR),
  chromePath: parsed.CHROME_PATH || undefined,
};

export type Config = typeof config;
