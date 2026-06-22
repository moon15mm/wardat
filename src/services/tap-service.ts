import axios from 'axios';
import { PaymentRequest } from '../types';
import logger from '../utils/logger';

export interface TapConfig {
  apiKey: string | null;
  successUrl: string | null;
}

export async function createTapCharge(
  config: TapConfig,
  payment: PaymentRequest
): Promise<{ url: string; sessionId: string }> {
  if (!config.apiKey) {
    throw new Error('Tap Payments API Key is not configured for this shop.');
  }

  try {
    const response = await axios.post(
      'https://api.tap.company/v2/charges',
      {
        amount: payment.price, // Tap takes normal units, not cents
        currency: payment.currency.toUpperCase() || 'SAR',
        customer: {
          first_name: payment.customerName || 'Customer',
          phone: {
            country_code: '',
            number: payment.customerPhone || '00000000',
          },
        },
        source: {
          id: 'src_all',
        },
        redirect: {
          url: config.successUrl || 'https://demo.wardat.xyz/payment/success',
        },
        description: `Order: ${payment.product}`,
        metadata: {
          orderId: payment.orderId,
          shopId: payment.shopId || '',
          customerPhone: payment.customerPhone,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }
    );

    const chargeId = response.data.id;
    const paymentUrl = response.data.transaction.url;

    logger.info(`[Tap] Charge created: ${chargeId} for order ${payment.orderId}`);
    return { url: paymentUrl, sessionId: chargeId };
  } catch (error: any) {
    logger.error(`[Tap] Charge creation failed: ${error.response?.data?.errors?.[0]?.description || error.message}`);
    throw new Error('فشل توليد رابط الدفع من تاب');
  }
}

export interface PaymentVerification {
  paid: boolean;
  amount: number;
}

/**
 * SECURITY: Re-query Tap for the authoritative status of a charge we created.
 * Never trust the unauthenticated webhook body — verify directly with Tap.
 */
export async function verifyTapPayment(
  apiKey: string | null,
  chargeId: string
): Promise<PaymentVerification> {
  if (!apiKey || !chargeId) return { paid: false, amount: 0 };
  try {
    const response = await axios.get(`https://api.tap.company/v2/charges/${encodeURIComponent(chargeId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      timeout: 15000,
    });
    const status = response.data?.status;
    const amount = Number(response.data?.amount) || 0;
    return { paid: status === 'CAPTURED', amount };
  } catch (error: any) {
    logger.error(`[Tap] Verify failed for charge ${chargeId}: ${error.response?.data?.errors?.[0]?.description || error.message}`);
    return { paid: false, amount: 0 };
  }
}
