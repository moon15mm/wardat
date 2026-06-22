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

export interface PaymentVerification {
  paid: boolean;
  amount: number; // normal units (SAR)
}

/**
 * SECURITY: Re-query Moyasar for the authoritative status of an invoice we created.
 * Webhook bodies are unauthenticated, so we NEVER trust the status they claim —
 * we ask Moyasar directly using the shop's own API key.
 */
export async function verifyMoyasarPayment(
  apiKey: string | null,
  invoiceId: string
): Promise<PaymentVerification> {
  if (!apiKey || !invoiceId) return { paid: false, amount: 0 };
  try {
    const authHeader = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
    const response = await axios.get(`https://api.moyasar.com/v1/invoices/${encodeURIComponent(invoiceId)}`, {
      headers: { Authorization: authHeader },
      timeout: 15000,
    });
    const status = response.data?.status;
    const amountHalalas = Number(response.data?.amount) || 0;
    return { paid: status === 'paid', amount: amountHalalas / 100 };
  } catch (error: any) {
    logger.error(`[Moyasar] Verify failed for invoice ${invoiceId}: ${error.response?.data?.message || error.message}`);
    return { paid: false, amount: 0 };
  }
}
