import { PaymentRequest } from '../types';
import { createCheckoutSession, StripeConfig } from '../services/stripe-service';
import { createMoyasarInvoice, MoyasarConfig } from '../services/moyasar-service';
import { createTapCharge, TapConfig } from '../services/tap-service';
import { createMyFatoorahInvoice, MyFatoorahConfig } from '../services/myfatoorah-service';
import { sendTextMessage, WhatsAppConfig } from '../services/whatsapp';
import { updateOrderPaymentSession } from './agent-3-excel';
import prisma from '../services/db';
import logger from '../utils/logger';
import { maskPhone } from '../utils/helpers';

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

  const whatsappConfig: WhatsAppConfig = {
    whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
    shopId: shop.id,
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
    ultramsgInstanceId: shop.ultramsgInstanceId,
    ultramsgToken: shop.ultramsgToken,
  };

  try {
    let url = '';
    let sessionId = '';
    const gateway = shop.paymentGateway || 'STRIPE';

    if (gateway === 'MOYASAR') {
      const config: MoyasarConfig = {
        apiKey: shop.moyasarApiKey,
        successUrl: shop.stripeSuccessUrl,
      };
      const res = await createMoyasarInvoice(config, payment);
      url = res.url;
      sessionId = res.sessionId;
    } else if (gateway === 'TAP') {
      const config: TapConfig = {
        apiKey: shop.tapApiKey,
        successUrl: shop.stripeSuccessUrl,
      };
      const res = await createTapCharge(config, payment);
      url = res.url;
      sessionId = res.sessionId;
    } else if (gateway === 'MYFATOORAH') {
      const config: MyFatoorahConfig = {
        apiKey: shop.myfatoorahApiKey,
        successUrl: shop.stripeSuccessUrl,
        cancelUrl: shop.stripeCancelUrl,
      };
      const res = await createMyFatoorahInvoice(config, payment);
      url = res.url;
      sessionId = res.sessionId;
    } else {
      // Default to STRIPE
      const config: StripeConfig = {
        secretKey: shop.stripeSecretKey,
        webhookSecret: shop.stripeWebhookSecret,
        successUrl: shop.stripeSuccessUrl,
        cancelUrl: shop.stripeCancelUrl,
      };
      const res = await createCheckoutSession(config, payment);
      url = res.url;
      sessionId = res.sessionId;
    }

    await updateOrderPaymentSession(payment.orderId, sessionId);

    const message =
      `💳 رابط الدفع جاهز!\n\n` +
      `المنتج: ${payment.product}\n` +
      `المبلغ: ${payment.price} ريال\n\n` +
      `اضغط على الرابط التالي للدفع:\n${url}\n\n` +
      `⏰ الرابط صالح لفترة محدودة`;

    await sendTextMessage(whatsappConfig, payment.customerPhone, message);
    logger.info(`[Agent2] Payment link sent to ${maskPhone(payment.customerPhone)} via ${gateway}`);
  } catch (err: any) {
    logger.error(`[Agent2] Payment processing failed: ${err.message}`);
    try {
      await sendTextMessage(
        whatsappConfig,
        payment.customerPhone,
        'عذراً، حدث خطأ في إعداد رابط الدفع. يرجى إبلاغ المتجر أو المحاولة لاحقاً.'
      );
    } catch (sendErr) {
      logger.error(`[Agent2] Failed to send error message to customer: ${sendErr}`);
    }
  }
}
