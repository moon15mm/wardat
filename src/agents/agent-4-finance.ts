import Stripe from 'stripe';
import { getSessionDetails, StripeConfig } from '../services/stripe-service';
import { sendTextMessage, sendToAdminGroup, WhatsAppConfig } from '../services/whatsapp';
import { updateOrderStatus, addFinanceRecord } from './agent-3-excel';
import { clearSession } from '../services/session';
import prisma from '../services/db';
import logger from '../utils/logger';

export async function handlePaymentSuccess(session: Stripe.Checkout.Session): Promise<void> {
  const sessionId = session.id;
  const orderId = session.metadata?.orderId;
  const customerPhone = session.metadata?.customerPhone;
  const customerName = session.metadata?.customerName;
  const shopId = session.metadata?.shopId;

  if (!orderId || !customerPhone || !shopId) {
    logger.error(`[Agent4] Missing metadata in Stripe session ${sessionId}`);
    return;
  }

  logger.info(`[Agent4] Payment succeeded for order ${orderId} in shop ${shopId}`);

  // Fetch shop config
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop) {
    logger.error(`[Agent4] Shop with ID ${shopId} not found`);
    return;
  }

  const stripeConfig: StripeConfig = {
    secretKey: shop.stripeSecretKey,
    webhookSecret: shop.stripeWebhookSecret,
    successUrl: shop.stripeSuccessUrl,
    cancelUrl: shop.stripeCancelUrl,
  };

  const whatsappConfig: WhatsAppConfig = {
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
  };

  let cardLast4 = '';
  try {
    const details = await getSessionDetails(stripeConfig, sessionId);
    const pi = details.payment_intent as Stripe.PaymentIntent | undefined;
    const charge = pi?.latest_charge as Stripe.Charge | undefined;
    cardLast4 = charge?.payment_method_details?.card?.last4 || '';
  } catch (err: any) {
    logger.warn(`[Agent4] Could not retrieve card details for ${sessionId}: ${err.message}`);
  }

  await updateOrderStatus(orderId, 'CONFIRMED', cardLast4);

  const amount = (session.amount_total || 0) / 100;
  await addFinanceRecord(orderId, amount, customerName || '');

  const customerMsg =
    `تم الدفع بنجاح! ✅\n\n` +
    `رقم طلبك: ${orderId}\n` +
    `المبلغ: ${amount} ريال\n\n` +
    `سيتم التوصيل في أقرب وقت.\nشكراً لتسوقك معنا! 🌹`;

  await sendTextMessage(whatsappConfig, customerPhone, customerMsg);

  const adminMsg =
    `🆕 NEW ORDER (${shop.name})\n` +
    `━━━━━━━━━━━━━━\n` +
    `📱 Customer Phone: ${customerPhone}\n` +
    `👤 Customer Name: ${customerName || ''}\n` +
    `🌹 Product: ${session.metadata?.product || 'N/A'}\n` +
    `💰 Price: ${amount} SAR\n` +
    `🚚 Delivery: YES\n` +
    `💳 Card: ****${cardLast4}\n` +
    `✅ Payment: CONFIRMED\n` +
    `📋 Order ID: ${orderId}\n` +
    `━━━━━━━━━━━━━━`;

  await sendToAdminGroup(whatsappConfig, adminMsg);

  await clearSession(customerPhone, shopId);
  logger.info(`[Agent4] Order ${orderId} fully processed`);
}

export async function handlePaymentFailed(session: Stripe.Checkout.Session): Promise<void> {
  const orderId = session.metadata?.orderId;
  const customerPhone = session.metadata?.customerPhone;
  const shopId = session.metadata?.shopId;

  if (!orderId || !customerPhone || !shopId) return;

  logger.warn(`[Agent4] Payment failed for order ${orderId} in shop ${shopId}`);

  // Fetch shop config
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop) return;

  const whatsappConfig: WhatsAppConfig = {
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
  };

  await updateOrderStatus(orderId, 'FAILED');

  await sendTextMessage(
    whatsappConfig,
    customerPhone,
    `عذراً، لم يتم الدفع بنجاح. ❌\n\nيمكنك المحاولة مرة أخرى أو التواصل معنا للمساعدة.`
  );
}
