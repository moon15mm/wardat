import { WhatsAppMessage, Product } from '../types';
import { getSession, updateSessionState, addMessage } from '../services/session';
import { getAIResponse, classifyIntent } from '../services/openai';
import { sendTextMessage, sendImageMessage, sendLocationRequest } from '../services/whatsapp';
import { getAllProducts, getProductByName, formatProductList } from '../products';
import { generateOrderId, formatPrice } from '../utils/helpers';
import { processPayment } from './agent-2-payment';
import { addOrder } from './agent-3-excel';
import logger from '../utils/logger';

export async function handleMessage(msg: WhatsAppMessage): Promise<void> {
  const phone = msg.from;
  const session = getSession(phone);

  logger.info(`[Agent1] Message from ${phone}, state: ${session.state}, type: ${msg.type}`);

  if (msg.type === 'location' && msg.location) {
    await handleLocation(phone, msg.location);
    return;
  }

  const userText = msg.text?.body || '';
  if (!userText) return;

  addMessage(phone, { role: 'user', content: userText });

  const intent = await classifyIntent(userText, session.state);
  logger.info(`[Agent1] Intent: ${intent.intent}`);

  switch (session.state) {
    case 'GREETING':
      await handleGreeting(phone, userText, intent.intent);
      break;
    case 'BROWSING':
      await handleBrowsing(phone, userText, intent);
      break;
    case 'SELECTING_PRODUCT':
      await handleProductSelection(phone, userText, intent);
      break;
    case 'COLLECTING_NAME':
      await handleCollectName(phone, userText, intent);
      break;
    case 'COLLECTING_PHONE':
      await handleCollectPhone(phone, userText, intent);
      break;
    case 'COLLECTING_RECIPIENT':
      await handleCollectRecipient(phone, userText, intent);
      break;
    case 'COLLECTING_LOCATION':
      await sendLocationRequest(phone);
      break;
    case 'CONFIRMING_ORDER':
      await handleConfirmation(phone, userText, intent.intent);
      break;
    case 'AWAITING_PAYMENT':
      await sendTextMessage(phone, 'طلبك قيد المعالجة. يرجى إتمام الدفع عبر الرابط المرسل.');
      break;
    default:
      await handleWithAI(phone);
  }
}

async function handleGreeting(phone: string, text: string, intent: string): Promise<void> {
  const greeting =
    'أهلاً وسهلاً بك في متجرنا! 🌹\n\nيسعدنا خدمتك. هل تود الاطلاع على منتجاتنا؟';

  await sendTextMessage(phone, greeting);
  addMessage(phone, { role: 'assistant', content: greeting });
  updateSessionState(phone, 'BROWSING');

  const productList = formatProductList();
  await sendTextMessage(phone, productList);
  addMessage(phone, { role: 'assistant', content: productList });
  updateSessionState(phone, 'SELECTING_PRODUCT');
}

async function handleBrowsing(
  phone: string,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> }
): Promise<void> {
  const productList = formatProductList();
  await sendTextMessage(phone, productList);
  addMessage(phone, { role: 'assistant', content: productList });
  updateSessionState(phone, 'SELECTING_PRODUCT');
}

async function handleProductSelection(
  phone: string,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> }
): Promise<void> {
  const session = getSession(phone);
  const products = getAllProducts();

  let selected: Product | undefined;
  const num = parseInt(text.trim());
  if (!isNaN(num) && num >= 1 && num <= products.length) {
    selected = products[num - 1];
  } else {
    selected = getProductByName(text.trim());
  }

  if (!selected) {
    await handleWithAI(phone);
    return;
  }

  session.selectedProduct = selected;
  session.orderData.product = selected.name;
  session.orderData.price = selected.price;
  session.orderData.productImageUrl = selected.imageUrl;

  const confirmation = `اختيار ممتاز! ✨\n\n${selected.name}\n${selected.description}\nالسعر: ${formatPrice(selected.price)}\n\nلإتمام الطلب، أحتاج بعض المعلومات.\nما اسمك الكريم؟`;

  await sendTextMessage(phone, confirmation);
  addMessage(phone, { role: 'assistant', content: confirmation });
  updateSessionState(phone, 'COLLECTING_NAME');
}

async function handleCollectName(
  phone: string,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> }
): Promise<void> {
  const session = getSession(phone);
  const name = intent.extractedData?.name || text.trim();

  session.orderData.customerName = name;
  session.orderData.customerPhone = phone;

  const reply = `شكراً ${name} 🙏\n\nهل الهدية لشخص آخر؟ ما اسم المستلم؟\n(إذا كانت لك شخصياً، اكتب "لي")`;
  await sendTextMessage(phone, reply);
  addMessage(phone, { role: 'assistant', content: reply });
  updateSessionState(phone, 'COLLECTING_RECIPIENT');
}

async function handleCollectPhone(
  phone: string,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> }
): Promise<void> {
  const session = getSession(phone);
  session.orderData.customerPhone = text.trim();

  const reply = 'ما اسم المستلم؟\n(إذا كانت لك شخصياً، اكتب "لي")';
  await sendTextMessage(phone, reply);
  addMessage(phone, { role: 'assistant', content: reply });
  updateSessionState(phone, 'COLLECTING_RECIPIENT');
}

async function handleCollectRecipient(
  phone: string,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> }
): Promise<void> {
  const session = getSession(phone);
  const recipient = text.trim().toLowerCase();

  session.orderData.recipientName =
    recipient === 'لي' || recipient === 'أنا'
      ? session.orderData.customerName || 'نفس العميل'
      : text.trim();

  const reply = 'رائع! 📍\n\nالآن يرجى إرسال موقع التوصيل.\nاضغط على 📎 ثم اختر "الموقع".';
  await sendTextMessage(phone, reply);
  addMessage(phone, { role: 'assistant', content: reply });
  updateSessionState(phone, 'COLLECTING_LOCATION');
}

async function handleLocation(
  phone: string,
  location: { latitude: number; longitude: number; name?: string; address?: string }
): Promise<void> {
  const session = getSession(phone);

  if (session.state !== 'COLLECTING_LOCATION') return;

  const locationUrl = `https://maps.google.com/maps?q=${location.latitude},${location.longitude}`;
  session.orderData.locationUrl = locationUrl;

  const summary =
    `ملخص طلبك:\n\n` +
    `🌹 المنتج: ${session.orderData.product}\n` +
    `💰 السعر: ${formatPrice(session.orderData.price || 0)}\n` +
    `👤 الاسم: ${session.orderData.customerName}\n` +
    `🎁 المستلم: ${session.orderData.recipientName}\n` +
    `📍 الموقع: تم الاستلام\n\n` +
    `هل تؤكد الطلب؟ (نعم / لا)`;

  await sendTextMessage(phone, summary);
  addMessage(phone, { role: 'assistant', content: summary });
  updateSessionState(phone, 'CONFIRMING_ORDER');
}

async function handleConfirmation(phone: string, text: string, intent: string): Promise<void> {
  const session = getSession(phone);
  const lower = text.trim().toLowerCase();

  if (intent === 'confirm' || lower === 'نعم' || lower === 'اي' || lower === 'تمام' || lower === 'أكيد') {
    const orderId = generateOrderId();
    session.orderData.id = orderId;
    session.orderData.timestamp = new Date().toISOString();
    session.orderData.paymentStatus = 'PENDING';

    await addOrder({
      id: orderId,
      timestamp: session.orderData.timestamp!,
      customerName: session.orderData.customerName || '',
      customerPhone: session.orderData.customerPhone || phone,
      recipientName: session.orderData.recipientName || '',
      product: session.orderData.product || '',
      price: session.orderData.price || 0,
      paymentStatus: 'PENDING',
      locationUrl: session.orderData.locationUrl || '',
      cardLast4: '',
      productImageUrl: session.orderData.productImageUrl || '',
      notes: '',
    });

    await sendTextMessage(phone, 'تم تأكيد طلبك! ✅\n\nجاري إعداد رابط الدفع...');
    addMessage(phone, { role: 'assistant', content: 'تم تأكيد الطلب وإعداد رابط الدفع' });
    updateSessionState(phone, 'AWAITING_PAYMENT');

    await processPayment({
      orderId,
      customerPhone: phone,
      customerName: session.orderData.customerName || '',
      product: session.orderData.product || '',
      price: session.orderData.price || 0,
      currency: process.env.CURRENCY || 'SAR',
    });
  } else if (intent === 'cancel' || lower === 'لا' || lower === 'إلغاء') {
    await sendTextMessage(phone, 'تم إلغاء الطلب. يمكنك البدء من جديد في أي وقت! 🙏');
    updateSessionState(phone, 'GREETING');
  } else {
    await sendTextMessage(phone, 'يرجى الرد بـ "نعم" لتأكيد الطلب أو "لا" للإلغاء.');
  }
}

async function handleWithAI(phone: string): Promise<void> {
  const session = getSession(phone);
  const productContext = `المنتجات المتوفرة:\n${formatProductList()}`;
  const reply = await getAIResponse(session.messages, productContext);
  await sendTextMessage(phone, reply);
  addMessage(phone, { role: 'assistant', content: reply });
}
