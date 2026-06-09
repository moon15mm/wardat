import Stripe from 'stripe';
import { PaymentRequest } from '../types';
import logger from '../utils/logger';

export interface StripeConfig {
  secretKey: string | null;
  webhookSecret: string | null;
  successUrl: string | null;
  cancelUrl: string | null;
}

function getStripeInstance(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    apiVersion: '2025-04-30.basil' as any,
  });
}

export async function createCheckoutSession(
  config: StripeConfig,
  payment: PaymentRequest
): Promise<{ url: string; sessionId: string }> {
  try {
    const stripe = getStripeInstance(config.secretKey || '');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: payment.currency.toLowerCase(),
            product_data: {
              name: payment.product,
            },
            unit_amount: Math.round(payment.price * 100), // Ensure integer in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: config.successUrl || '',
      cancel_url: config.cancelUrl || '',
      metadata: {
        orderId: payment.orderId,
        customerPhone: payment.customerPhone,
        customerName: payment.customerName,
        shopId: payment.shopId || '', // Store shopId in metadata
        product: payment.product,
      },
    });

    logger.info(`Stripe session created: ${session.id} for order ${payment.orderId}`);
    return { url: session.url!, sessionId: session.id };
  } catch (err: any) {
    logger.error(`Stripe session creation failed: ${err.message}`);
    throw err;
  }
}

export function constructWebhookEvent(
  config: StripeConfig,
  body: Buffer,
  signature: string
): Stripe.Event {
  const stripe = getStripeInstance(config.secretKey || '');
  return stripe.webhooks.constructEvent(
    body,
    signature,
    config.webhookSecret || ''
  );
}

export async function getSessionDetails(
  config: StripeConfig,
  sessionId: string
): Promise<Stripe.Checkout.Session> {
  const stripe = getStripeInstance(config.secretKey || '');
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.latest_charge'],
  });
}
