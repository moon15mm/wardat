import Stripe from 'stripe';
import { PaymentRequest } from '../types';
import logger from '../utils/logger';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-04-30.basil',
});

export async function createCheckoutSession(
  payment: PaymentRequest
): Promise<{ url: string; sessionId: string }> {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: payment.currency.toLowerCase(),
            product_data: {
              name: payment.product,
            },
            unit_amount: payment.price * 100,
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: process.env.STRIPE_SUCCESS_URL || 'https://example.com/success',
      cancel_url: process.env.STRIPE_CANCEL_URL || 'https://example.com/cancel',
      metadata: {
        orderId: payment.orderId,
        customerPhone: payment.customerPhone,
        customerName: payment.customerName,
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
  body: Buffer,
  signature: string
): Stripe.Event {
  return stripe.webhooks.constructEvent(
    body,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET!
  );
}

export async function getSessionDetails(
  sessionId: string
): Promise<Stripe.Checkout.Session> {
  return stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['payment_intent.latest_charge'],
  });
}
