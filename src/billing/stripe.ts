import Stripe from 'stripe';
import { config } from '../config.js';
import { getDb } from '../db/schema.js';
import { logger } from '../server.js';

let stripeClient: Stripe | null = null;

export function getStripe(): Stripe {
  if (stripeClient) return stripeClient;
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  stripeClient = new Stripe(config.STRIPE_SECRET_KEY);
  return stripeClient;
}

/**
 * Report metered usage to Stripe for the given API key.
 * Uses Billing Meter Events API (Stripe v2+ / SDK v22+).
 * Called when a browser session is released.
 */
export async function reportUsage(apiKey: string, browserHours: number): Promise<void> {
  if (!config.stripeEnabled) return;

  const db = getDb();
  const row = db.prepare(
    'SELECT stripe_customer_id FROM api_keys WHERE key = ? AND is_active = 1'
  ).get(apiKey) as { stripe_customer_id: string | null } | undefined;

  if (!row?.stripe_customer_id) return;

  try {
    const stripe = getStripe();
    // Report usage as a meter event. The value is in hundredths of a browser-hour
    // (1 unit = 0.01 hours = 36 seconds) to give sub-hour precision with integer values.
    const value = Math.max(1, Math.round(browserHours * 100));

    await stripe.billing.meterEvents.create({
      event_name: config.STRIPE_METER_EVENT_NAME,
      payload: {
        stripe_customer_id: row.stripe_customer_id,
        value: String(value),
      },
      timestamp: Math.floor(Date.now() / 1000),
    });

    logger.info({ apiKey: apiKey.slice(0, 8) + '...', browserHours, value }, 'Reported usage to Stripe');
  } catch (err: any) {
    logger.error({ error: err.message, apiKey: apiKey.slice(0, 8) + '...' }, 'Failed to report usage to Stripe');
  }
}
