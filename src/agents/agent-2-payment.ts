import { PaymentRequest } from '../types';
import { createCheckoutSession } from '../services/stripe-service';
import { sendTextMessage } from '../services/whatsapp';
import { updateOrderPaymentSession } from './agent-3-excel';
import logger from '../utils/logger';

export async function processPayment(payment: PaymentRequest): Promise<void> {
  logger.info(`[Agent2] Processing payment for order ${payment.orderId}`);

  try {
    const { url, sessionId } = await createCheckoutSession(payment);

    await updateOrderPaymentSession(payment.orderId, sessionId);

    const message =
      `💳 رابط الدفع جاهز!\n\n` +
      `المنتج: ${payment.product}\n` +
      `المبلغ: ${payment.price} ريال\n\n` +
      `اضغط على الرابط التالي للدفع:\n${url}\n\n` +
      `⏰ الرابط صالح لمدة 30 دقيقة`;

    await sendTextMessage(payment.customerPhone, message);
    logger.info(`[Agent2] Payment link sent to ${payment.customerPhone}`);
  } catch (err: any) {
    logger.error(`[Agent2] Payment processing failed: ${err.message}`);
    await sendTextMessage(
      payment.customerPhone,
      'عذراً، حدث خطأ في إعداد رابط الدفع. سيتواصل معك فريقنا قريباً.'
    );
  }
}
