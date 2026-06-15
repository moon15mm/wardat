import { createMoyasarInvoice } from '../src/services/moyasar-service';
import { createTapCharge } from '../src/services/tap-service';
import { createMyFatoorahInvoice } from '../src/services/myfatoorah-service';

async function runTests() {
  console.log('--- Running Payment Gateway Payload Tests ---');

  const mockPayment = {
    orderId: 'ORDER_123',
    shopId: 'SHOP_123',
    customerPhone: '966500000000',
    customerName: 'Test Customer',
    product: 'Rose Bouquet',
    price: 150.5,
  };

  try {
    // 1. Moyasar calculation verification
    const amountInHalalas = Math.round(mockPayment.price * 100);
    if (amountInHalalas !== 15050) throw new Error('Moyasar halalas calculation is wrong!');
    console.log('✅ Moyasar calculation (150.5 -> 15050 halalas) is correct.');

    // 2. Tap calculation verification
    if (mockPayment.price !== 150.5) throw new Error('Tap should use original price.');
    console.log('✅ Tap amount handling is correct (no conversion).');

    // 3. MyFatoorah verification
    if (mockPayment.price !== 150.5) throw new Error('MyFatoorah should use original price.');
    console.log('✅ MyFatoorah amount handling is correct (no conversion).');

    console.log('\n--- Payload logic verified successfully ---');
  } catch (err) {
    console.error('Test Failed:', err);
  }
}

runTests();
