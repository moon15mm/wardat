import { PaymentRequest } from '../types';
import { createCheckoutSession, StripeConfig } from '../services/stripe-service';
import { sendTextMessage, WhatsAppConfig } from '../services/whatsapp';
import { updateOrderPaymentSession } from './agent-3-excel';
import prisma from '../services/db';
import logger from '../utils/logger';

export async function processPayment(payment: PaymentRequest): Promise<void> {
  logger.info(`[Agent2] Processing payment for order ${payment.orderId} (Shop: ${payment.shopId})`);

  // Fetch shop config
  const shop = await prisma.shop.findUnique({
    where: { id: payment.shopId },
  });

  if (!shop) {
    logger.error(`[Agent2] Shop with ID ${payment.shopId} not found`);
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
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
    ultramsgInstanceId: shop.ultramsgInstanceId,
    ultramsgToken: shop.ultramsgToken,
  };

  try {
    const { url, sessionId } = await createCheckoutSession(stripeConfig, payment);

    await updateOrderPaymentSession(payment.orderId, sessionId);

    const message =
      `💳 رابط الدفع جاهز!\n\n` +
      `المنتج: ${payment.product}\n` +
      `المبلغ: ${payment.price} ريال\n\n` +
      `اضغط على الرابط التالي للدفع:\n${url}\n\n` +
      `⏰ الرابط صالح لمدة 30 دقيقة`;

    await sendTextMessage(whatsappConfig, payment.customerPhone, message);
    logger.info(`[Agent2] Payment link sent to ${payment.customerPhone}`);
  } catch (err: any) {
    logger.error(`[Agent2] Payment processing failed: ${err.message}`);
    try {
      await sendTextMessage(
        whatsappConfig,
        payment.customerPhone,
        'عذراً، حدث خطأ في إعداد رابط الدفع. سيتواصل معك فريقنا قريباً.'
      );
    } catch (sendErr) {
      logger.error(`[Agent2] Failed to send error message to customer: ${sendErr}`);
    }
  }
}
