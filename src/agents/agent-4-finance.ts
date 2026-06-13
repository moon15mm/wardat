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

  // SECURITY: verify the order actually belongs to the shop named in the metadata.
  // Without this, a shop owner could sign a valid webhook (with their own secret)
  // referencing another shop's orderId and confirm it without payment.
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    logger.error(`[Agent4] Order ${orderId} not found; ignoring payment event`);
    return;
  }
  if (order.shopId !== shopId) {
    logger.error(`[Agent4] SECURITY: order ${orderId} belongs to shop ${order.shopId}, not ${shopId}. Rejecting.`);
    return;
  }
  // Idempotency: if already confirmed, do nothing (prevents double stock decrement / double notify).
  if (order.paymentStatus === 'CONFIRMED') {
    logger.info(`[Agent4] Order ${orderId} already confirmed; skipping.`);
    return;
  }

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
    whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
    shopId: shop.id,
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
    ultramsgInstanceId: shop.ultramsgInstanceId,
    ultramsgToken: shop.ultramsgToken,
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

  // Decrement product stock if order is linked to a product.
  // Conditional update (stock > 0) prevents stock from going negative under races.
  try {
    if (order.productId) {
      const result = await prisma.product.updateMany({
        where: { id: order.productId, stock: { gt: 0 } },
        data: { stock: { decrement: 1 } },
      });
      if (result.count > 0) {
        logger.info(`[Agent4] Decremented stock for product ${order.productId} (Order: ${orderId})`);
      } else {
        logger.warn(`[Agent4] Stock not decremented for product ${order.productId} (already 0) (Order: ${orderId})`);
      }
    }
  } catch (err: any) {
    logger.error(`[Agent4] Failed to decrement product stock for order ${orderId}: ${err.message}`);
  }

  const amount = (session.amount_total || 0) / 100;
  await addFinanceRecord(orderId, amount, customerName || '');

  const isPickup = order.fulfillmentType === 'PICKUP';
  const timeLine = order.preferredTime ? `\nالوقت المطلوب: ${order.preferredTime}` : '';

  const customerMsg =
    `تم الدفع بنجاح! ✅\n\n` +
    `رقم طلبك: ${orderId}\n` +
    `المبلغ: ${amount} ريال\n` +
    (isPickup ? `📦 الاستلام: من المحل${timeLine}` : `🚚 التوصيل: إلى موقعك${timeLine}`) +
    `\n\nشكراً لتسوقك معنا! 🌹`;

  await sendTextMessage(whatsappConfig, customerPhone, customerMsg);

  const adminMsg =
    `🆕 NEW ORDER (${shop.name})\n` +
    `━━━━━━━━━━━━━━\n` +
    `📱 Customer Phone: ${customerPhone}\n` +
    `👤 Customer Name: ${customerName || ''}\n` +
    `🌹 Product: ${session.metadata?.product || 'N/A'}\n` +
    `💰 Price: ${amount} SAR\n` +
    `${isPickup ? '🏬 الاستلام: من المحل' : '🚚 التوصيل: إلى الموقع'}${order.preferredTime ? ' | الوقت: ' + order.preferredTime : ''}\n` +
    (!isPickup && order.locationUrl && order.locationUrl.startsWith('http') ? `📍 الموقع: ${order.locationUrl}\n` : '') +
    `💳 Card: ****${cardLast4}\n` +
    `📋 Order ID: ${orderId}\n` +
    `━━━━━━━━━━━━━━`;

  try {
    await sendToAdminGroup(whatsappConfig, adminMsg);
  } catch (err) {
    logger.warn(`[Agent4] Failed to send admin notification for order ${orderId}: ${err}`);
  }

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
    whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
    shopId: shop.id,
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
    ultramsgInstanceId: shop.ultramsgInstanceId,
    ultramsgToken: shop.ultramsgToken,
  };

  await updateOrderStatus(orderId, 'FAILED');

  await sendTextMessage(
    whatsappConfig,
    customerPhone,
    `عذراً، لم يتم الدفع بنجاح. ❌\n\nيمكنك المحاولة مرة أخرى أو التواصل معنا للمساعدة.`
  );
}

export async function handleSubscriptionRenewalSuccess(session: Stripe.Checkout.Session): Promise<void> {
  const shopId = session.metadata?.shopId;
  const plan = session.metadata?.plan;
  const durationMonths = parseInt(session.metadata?.durationMonths || '1');

  if (!shopId || !plan) {
    logger.error(`[Agent4] Missing metadata in Stripe subscription renewal session ${session.id}`);
    return;
  }

  logger.info(`[Agent4] Subscription renewal succeeded for shop ${shopId}. Plan: ${plan}, Months: ${durationMonths}`);

  // Fetch shop config
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop) {
    logger.error(`[Agent4] Shop with ID ${shopId} not found for subscription renewal`);
    return;
  }

  // Calculate new subscription end date
  const baseDate = shop.subscriptionEnd && new Date(shop.subscriptionEnd) > new Date()
    ? new Date(shop.subscriptionEnd)
    : new Date();

  const newEnd = new Date(baseDate.getTime() + durationMonths * 30 * 24 * 60 * 60 * 1000);

  await prisma.shop.update({
    where: { id: shopId },
    data: {
      subscriptionPlan: plan,
      subscriptionStatus: 'ACTIVE',
      subscriptionEnd: newEnd,
    },
  });

  logger.info(`[Agent4] Shop ${shop.name} subscription successfully updated/extended to ${newEnd.toISOString()}`);
}
