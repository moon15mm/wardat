import Stripe from 'stripe';
import { getSessionDetails } from '../services/stripe-service';
import { sendTextMessage, sendToAdminGroup } from '../services/whatsapp';
import { updateOrderStatus, addFinanceRecord, getOrderByStripeSession } from './agent-3-excel';
import { clearSession } from '../services/session';
import logger from '../utils/logger';

export async function handlePaymentSuccess(session: Stripe.Checkout.Session): Promise<void> {
  const sessionId = session.id;
  const orderId = session.metadata?.orderId;
  const customerPhone = session.metadata?.customerPhone;
  const customerName = session.metadata?.customerName;

  if (!orderId || !customerPhone) {
    logger.error(`[Agent4] Missing metadata in Stripe session ${sessionId}`);
    return;
  }

  logger.info(`[Agent4] Payment succeeded for order ${orderId}`);

  let cardLast4 = '';
  try {
    const details = await getSessionDetails(sessionId);
    const pi = details.payment_intent as Stripe.PaymentIntent | undefined;
    const charge = pi?.latest_charge as Stripe.Charge | undefined;
    cardLast4 = charge?.payment_method_details?.card?.last4 || '';
  } catch {
    logger.warn(`[Agent4] Could not retrieve card details for ${sessionId}`);
  }

  await updateOrderStatus(orderId, 'CONFIRMED', cardLast4);

  const amount = (session.amount_total || 0) / 100;
  await addFinanceRecord(orderId, amount, customerName || '');

  const customerMsg =
    `تم الدفع بنجاح! ✅\n\n` +
    `رقم طلبك: ${orderId}\n` +
    `المبلغ: ${amount} ريال\n\n` +
    `سيتم التوصيل في أقرب وقت.\nشكراً لتسوقك معنا! 🌹`;

  await sendTextMessage(customerPhone, customerMsg);

  const orderData = await getOrderByStripeSession(sessionId);

  const adminMsg =
    `🆕 NEW ORDER\n` +
    `━━━━━━━━━━━━━━\n` +
    `📱 Customer Phone: ${customerPhone}\n` +
    `👤 Customer Name: ${customerName || ''}\n` +
    `🎁 Recipient: ${orderData ? 'See order file' : 'N/A'}\n` +
    `🌹 Product: ${session.metadata?.product || 'N/A'}\n` +
    `💰 Price: ${amount} SAR\n` +
    `🚚 Delivery: YES\n` +
    `💳 Card: ****${cardLast4}\n` +
    `✅ Payment: CONFIRMED\n` +
    `📋 Order ID: ${orderId}\n` +
    `━━━━━━━━━━━━━━`;

  await sendToAdminGroup(adminMsg);

  clearSession(customerPhone);
  logger.info(`[Agent4] Order ${orderId} fully processed`);
}

export async function handlePaymentFailed(session: Stripe.Checkout.Session): Promise<void> {
  const orderId = session.metadata?.orderId;
  const customerPhone = session.metadata?.customerPhone;

  if (!orderId || !customerPhone) return;

  logger.warn(`[Agent4] Payment failed for order ${orderId}`);

  await updateOrderStatus(orderId, 'FAILED');

  await sendTextMessage(
    customerPhone,
    `عذراً، لم يتم الدفع بنجاح. ❌\n\nيمكنك المحاولة مرة أخرى أو التواصل معنا للمساعدة.`
  );
}
