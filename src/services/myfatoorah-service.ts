import axios from 'axios';
import { PaymentRequest } from '../types';
import logger from '../utils/logger';

export interface MyFatoorahConfig {
  apiKey: string | null;
  successUrl: string | null;
  cancelUrl: string | null;
}

export async function createMyFatoorahInvoice(
  config: MyFatoorahConfig,
  payment: PaymentRequest
): Promise<{ url: string; sessionId: string }> {
  if (!config.apiKey) {
    throw new Error('MyFatoorah API Key is not configured for this shop.');
  }

  try {
    const isTest = config.apiKey.startsWith('rLtt6JW'); // Typically MyFatoorah test tokens start like this
    const baseUrl = isTest ? 'https://apitest.myfatoorah.com' : 'https://api-sa.myfatoorah.com';

    const response = await axios.post(
      `${baseUrl}/v2/SendPayment`,
      {
        CustomerName: payment.customerName || 'Customer',
        NotificationOption: 'Lnk',
        InvoiceValue: payment.price,
        CurrencyIso: payment.currency.toUpperCase() || 'SAR',
        CustomerReference: payment.orderId,
        UserDefinedField: payment.shopId, // Using UserDefinedField to pass shopId
        CallBackUrl: config.successUrl || 'https://demo.wardat.xyz/payment/success',
        ErrorUrl: config.cancelUrl || 'https://demo.wardat.xyz/payment/cancel',
      },
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.IsSuccess === true) {
      const invoiceId = response.data.Data.InvoiceId.toString();
      const invoiceUrl = response.data.Data.InvoiceURL;

      logger.info(`[MyFatoorah] Invoice created: ${invoiceId} for order ${payment.orderId}`);
      return { url: invoiceUrl, sessionId: invoiceId };
    } else {
      throw new Error(response.data.Message || 'Unknown error from MyFatoorah');
    }
  } catch (error: any) {
    logger.error(`[MyFatoorah] Invoice creation failed: ${error.response?.data?.Message || error.message}`);
    throw new Error('فشل توليد رابط الدفع من ماي فاتورة');
  }
}
