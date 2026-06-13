import axios from 'axios';
import { PaymentRequest } from '../types';
import logger from '../utils/logger';

export interface MoyasarConfig {
  apiKey: string | null;
  successUrl: string | null;
}

export async function createMoyasarInvoice(
  config: MoyasarConfig,
  payment: PaymentRequest
): Promise<{ url: string; sessionId: string }> {
  if (!config.apiKey) {
    throw new Error('Moyasar API Key is not configured for this shop.');
  }

  try {
    const amountInHalalas = Math.round(payment.price * 100);
    const authHeader = `Basic ${Buffer.from(`${config.apiKey}:`).toString('base64')}`;

    const response = await axios.post(
      'https://api.moyasar.com/v1/invoices',
      {
        amount: amountInHalalas,
        currency: payment.currency.toUpperCase() || 'SAR',
        description: `Order: ${payment.product}`,
        success_url: config.successUrl || 'https://demo.wardat.xyz/payment/success',
        metadata: {
          orderId: payment.orderId,
          shopId: payment.shopId || '',
          customerPhone: payment.customerPhone,
        },
      },
      {
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
      }
    );

    const invoiceId = response.data.id;
    const invoiceUrl = response.data.url;

    logger.info(`[Moyasar] Invoice created: ${invoiceId} for order ${payment.orderId}`);
    return { url: invoiceUrl, sessionId: invoiceId };
  } catch (error: any) {
    logger.error(`[Moyasar] Invoice creation failed: ${error.response?.data?.message || error.message}`);
    throw new Error('فشل توليد رابط الدفع من ميسر');
  }
}
