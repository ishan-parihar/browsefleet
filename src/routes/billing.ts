import { Hono } from 'hono';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { getStripe } from '../billing/stripe.js';
import { getDb } from '../db/schema.js';
import { getUsageStats } from '../db/usage.js';
import { logger } from '../server.js';

/**
 * Billing routes that require authentication (checkout, portal, usage).
 */
export function billingRoutes(): Hono {
  const app = new Hono();

  // POST /checkout — create Stripe Checkout session for subscription signup
  app.post('/checkout', async (c) => {
    if (!config.stripeEnabled) {
      return c.json({ error: 'Stripe is not configured' }, 503);
    }

    const stripe = getStripe();
    const body = (await c.req.json().catch(() => ({}))) as {
      successUrl?: string;
      cancelUrl?: string;
    };

    const baseUrl = new URL(c.req.url).origin;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: config.STRIPE_PRICE_ID,
        // For metered billing, don't set quantity — Stripe tracks usage
      }],
      success_url: body.successUrl ?? `${baseUrl}/billing/success`,
      cancel_url: body.cancelUrl ?? `${baseUrl}/billing/cancel`,
    });

    return c.json({ checkoutUrl: session.url, sessionId: session.id });
  });

  // POST /portal — create Stripe Customer Portal session
  app.post('/portal', async (c) => {
    if (!config.stripeEnabled) {
      return c.json({ error: 'Stripe is not configured' }, 503);
    }

    const apiKey = c.req.header('x-api-key');
    if (!apiKey) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const db = getDb();
    const row = db.prepare(
      'SELECT stripe_customer_id FROM api_keys WHERE key = ?'
    ).get(apiKey) as { stripe_customer_id: string | null } | undefined;

    if (!row?.stripe_customer_id) {
      return c.json({ error: 'No Stripe customer linked to this API key' }, 404);
    }

    const stripe = getStripe();
    const body = (await c.req.json().catch(() => ({}))) as { returnUrl?: string };

    const baseUrl = new URL(c.req.url).origin;
    const session = await stripe.billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: body.returnUrl ?? `${baseUrl}/`,
    });

    return c.json({ portalUrl: session.url });
  });

  // GET /usage — current billing period usage for the authenticated API key
  app.get('/usage', async (c) => {
    const apiKey = c.req.header('x-api-key') ?? undefined;
    const stats = getUsageStats(apiKey);

    // If Stripe is enabled and the key is linked, fetch current period from the subscription item
    let currentPeriod: { start: string; end: string } | null = null;
    if (config.stripeEnabled && apiKey) {
      const db = getDb();
      const row = db.prepare(
        'SELECT stripe_subscription_item_id FROM api_keys WHERE key = ?'
      ).get(apiKey) as { stripe_subscription_item_id: string | null } | undefined;

      if (row?.stripe_subscription_item_id) {
        try {
          const stripe = getStripe();
          const item = await stripe.subscriptionItems.retrieve(row.stripe_subscription_item_id);
          currentPeriod = {
            start: new Date(item.current_period_start * 1000).toISOString(),
            end: new Date(item.current_period_end * 1000).toISOString(),
          };
        } catch {
          // Subscription may have been deleted; ignore
        }
      }
    }

    return c.json({ ...stats, currentPeriod });
  });

  return app;
}

/**
 * Webhook route — no auth middleware, Stripe signs the payload.
 */
export function billingWebhookRoute(): Hono {
  const app = new Hono();

  app.post('/webhook', async (c) => {
    if (!config.stripeEnabled) {
      return c.json({ error: 'Stripe is not configured' }, 503);
    }

    const stripe = getStripe();
    const signature = c.req.header('stripe-signature');
    if (!signature) {
      return c.json({ error: 'Missing stripe-signature header' }, 400);
    }

    const rawBody = await c.req.text();

    let event: import('stripe').Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Stripe webhook signature verification failed');
      return c.json({ error: 'Invalid signature' }, 400);
    }

    const db = getDb();

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const customerId = session.customer as string;
        const subscriptionId = session.subscription as string;

        // Retrieve subscription to get the subscription item ID
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const subscriptionItemId = subscription.items.data[0]?.id;

        // Generate a new API key for this customer
        const newApiKey = `bf_${uuid().replace(/-/g, '')}`;

        db.prepare(`
          INSERT INTO api_keys (key, name, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id)
          VALUES (?, ?, ?, ?, ?)
        `).run(newApiKey, `stripe-${customerId.slice(-8)}`, customerId, subscriptionId, subscriptionItemId ?? null);

        // TODO: Deliver the API key to the customer — options: send via email,
        // store in Stripe customer metadata, or provide a one-time retrieval endpoint.
        logger.info({ customerId, apiKey: newApiKey.slice(0, 12) + '...' }, 'New subscription — API key created');
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const customerId = subscription.customer as string;

        db.prepare(
          'UPDATE api_keys SET is_active = 0 WHERE stripe_customer_id = ?'
        ).run(customerId);

        logger.info({ customerId }, 'Subscription deleted — API key deactivated');
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const customerId = invoice.customer as string;

        db.prepare(
          'UPDATE api_keys SET is_active = 0 WHERE stripe_customer_id = ?'
        ).run(customerId);

        logger.info({ customerId }, 'Payment failed — API key deactivated');
        break;
      }

      default:
        logger.debug({ type: event.type }, 'Unhandled Stripe webhook event');
    }

    return c.json({ received: true });
  });

  return app;
}
