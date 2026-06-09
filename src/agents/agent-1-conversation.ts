import { WhatsAppMessage, Product, Session } from '../types';
import { getSession } from '../services/session';
import { getAIResponse, classifyIntent } from '../services/openai';
import { sendTextMessage, sendLocationRequest, WhatsAppConfig } from '../services/whatsapp';
import { getAllProducts, getProductByName, formatProductList } from '../products';
import { generateOrderId, formatPrice } from '../utils/helpers';
import { processPayment } from './agent-2-payment';
import { addOrder } from './agent-3-excel';
import prisma from '../services/db';
import logger from '../utils/logger';

export async function handleMessage(msg: WhatsAppMessage, shopId: string): Promise<void> {
  const phone = msg.from;

  // 1. Fetch shop credentials
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
  });

  if (!shop) {
    logger.error(`[Agent1] Shop with ID ${shopId} not found`);
    return;
  }

  const whatsappConfig: WhatsAppConfig = {
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
  };

  // 2. Fetch session from DB
  const session = await getSession(phone, shopId);

  logger.info(`[Agent1] Message from ${phone} for shop ${shop.name} (${shopId}), state: ${session.state}, type: ${msg.type}`);

  if (msg.type === 'location' && msg.location) {
    await handleLocation(phone, shopId, whatsappConfig, msg.location, session);
    await saveSession(session, shopId);
    return;
  }

  const userText = msg.text?.body || '';
  if (!userText) return;

  // Append user message in-memory
  session.messages.push({ role: 'user', content: userText });

  const intent = await classifyIntent(userText, session.state);
  logger.info(`[Agent1] Intent: ${intent.intent}`);

  switch (session.state) {
    case 'GREETING':
      await handleGreeting(phone, shopId, whatsappConfig, userText, intent.intent, session);
      break;
    case 'BROWSING':
      await handleBrowsing(phone, shopId, whatsappConfig, userText, intent, session);
      break;
    case 'SELECTING_PRODUCT':
      await handleProductSelection(phone, shopId, whatsappConfig, userText, intent, session);
      break;
    case 'COLLECTING_NAME':
      await handleCollectName(phone, shopId, whatsappConfig, userText, intent, session);
      break;
    case 'COLLECTING_PHONE':
      await handleCollectPhone(phone, shopId, whatsappConfig, userText, intent, session);
      break;
    case 'COLLECTING_RECIPIENT':
      await handleCollectRecipient(phone, shopId, whatsappConfig, userText, intent, session);
      break;
    case 'COLLECTING_LOCATION':
      await sendLocationRequest(whatsappConfig, phone);
      break;
    case 'CONFIRMING_ORDER':
      await handleConfirmation(phone, shopId, whatsappConfig, userText, intent.intent, session);
      break;
    case 'AWAITING_PAYMENT':
      await sendTextMessage(whatsappConfig, phone, 'طلبك قيد المعالجة. يرجى إتمام الدفع عبر الرابط المرسل.');
      break;
    default:
      await handleWithAI(phone, shopId, whatsappConfig, session);
  }

  // 3. Persist the updated session back to DB
  await saveSession(session, shopId);
}

// Helper function to commit session state to the database
async function saveSession(session: Session, shopId: string): Promise<void> {
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-10);
  }

  await prisma.session.update({
    where: {
      phone_shopId: {
        phone: session.phone,
        shopId: shopId,
      },
    },
    data: {
      state: session.state,
      messages: JSON.stringify(session.messages),
      orderData: JSON.stringify(session.orderData),
      selectedProductId: session.selectedProduct?.id || null,
      lastActivity: BigInt(Date.now()),
    },
  });
}

async function handleGreeting(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  intent: string,
  session: Session
): Promise<void> {
  const greeting = 'أهلاً وسهلاً بك في متجرنا! 🌹\n\nيسعدنا خدمتك. هل تود الاطلاع على منتجاتنا؟';

  await sendTextMessage(whatsappConfig, phone, greeting);
  session.messages.push({ role: 'assistant', content: greeting });
  session.state = 'BROWSING';

  const productList = await formatProductList(shopId);
  await sendTextMessage(whatsappConfig, phone, productList);
  session.messages.push({ role: 'assistant', content: productList });
  session.state = 'SELECTING_PRODUCT';
}

async function handleBrowsing(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> },
  session: Session
): Promise<void> {
  const productList = await formatProductList(shopId);
  await sendTextMessage(whatsappConfig, phone, productList);
  session.messages.push({ role: 'assistant', content: productList });
  session.state = 'SELECTING_PRODUCT';
}

async function handleProductSelection(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> },
  session: Session
): Promise<void> {
  const products = await getAllProducts(shopId);

  let selected: Product | null = null;
  const num = parseInt(text.trim());
  if (!isNaN(num) && num >= 1 && num <= products.length) {
    selected = products[num - 1];
  } else {
    selected = await getProductByName(shopId, text.trim());
  }

  if (!selected) {
    await handleWithAI(phone, shopId, whatsappConfig, session);
    return;
  }

  session.selectedProduct = selected;
  session.orderData.product = selected.name;
  session.orderData.price = selected.price;
  session.orderData.productImageUrl = selected.imageUrl;

  const confirmation = `اختيار ممتاز! ✨\n\n${selected.name}\n${selected.description}\nالسعر: ${formatPrice(selected.price)}\n\nلإتمام الطلب، أحتاج بعض المعلومات.\nما اسمك الكريم؟`;

  await sendTextMessage(whatsappConfig, phone, confirmation);
  session.messages.push({ role: 'assistant', content: confirmation });
  session.state = 'COLLECTING_NAME';
}

async function handleCollectName(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> },
  session: Session
): Promise<void> {
  const name = intent.extractedData?.name || text.trim();

  session.orderData.customerName = name;
  session.orderData.customerPhone = phone;

  const reply = `شكراً ${name} 🙏\n\nهل الهدية لشخص آخر؟ ما اسم المستلم؟\n(إذا كانت لك شخصياً، اكتب "لي")`;
  await sendTextMessage(whatsappConfig, phone, reply);
  session.messages.push({ role: 'assistant', content: reply });
  session.state = 'COLLECTING_RECIPIENT';
}

async function handleCollectPhone(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> },
  session: Session
): Promise<void> {
  session.orderData.customerPhone = text.trim();

  const reply = 'ما اسم المستلم؟\n(إذا كانت لك شخصياً، اكتب "لي")';
  await sendTextMessage(whatsappConfig, phone, reply);
  session.messages.push({ role: 'assistant', content: reply });
  session.state = 'COLLECTING_RECIPIENT';
}

async function handleCollectRecipient(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  intent: { intent: string; extractedData?: Record<string, string> },
  session: Session
): Promise<void> {
  const recipient = text.trim().toLowerCase();

  session.orderData.recipientName =
    recipient === 'لي' || recipient === 'أنا'
      ? session.orderData.customerName || 'نفس العميل'
      : text.trim();

  const reply = 'رائع! 📍\n\nالآن يرجى إرسال موقع التوصيل.\nاضغط على 📎 ثم اختر "الموقع".';
  await sendTextMessage(whatsappConfig, phone, reply);
  session.messages.push({ role: 'assistant', content: reply });
  session.state = 'COLLECTING_LOCATION';
}

async function handleLocation(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  location: { latitude: number; longitude: number; name?: string; address?: string },
  session: Session
): Promise<void> {
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

  await sendTextMessage(whatsappConfig, phone, summary);
  session.messages.push({ role: 'assistant', content: summary });
  session.state = 'CONFIRMING_ORDER';
}

async function handleConfirmation(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  intent: string,
  session: Session
): Promise<void> {
  const lower = text.trim().toLowerCase();

  if (intent === 'confirm' || lower === 'نعم' || lower === 'اي' || lower === 'تمام' || lower === 'أكيد') {
    const orderId = generateOrderId();
    session.orderData.id = orderId;
    session.orderData.shopId = shopId;
    session.orderData.timestamp = new Date().toISOString();
    session.orderData.paymentStatus = 'PENDING';

    await addOrder({
      id: orderId,
      shopId: shopId,
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

    await sendTextMessage(whatsappConfig, phone, 'تم تأكيد طلبك! ✅\n\nجاري إعداد رابط الدفع...');
    session.messages.push({ role: 'assistant', content: 'تم تأكيد الطلب وإعداد رابط الدفع' });
    session.state = 'AWAITING_PAYMENT';

    await processPayment({
      orderId,
      shopId: shopId,
      customerPhone: phone,
      customerName: session.orderData.customerName || '',
      product: session.orderData.product || '',
      price: session.orderData.price || 0,
      currency: 'SAR',
    });
  } else if (intent === 'cancel' || lower === 'لا' || lower === 'إلغاء') {
    await sendTextMessage(whatsappConfig, phone, 'تم إلغاء الطلب. يمكنك البدء من جديد في أي وقت! 🙏');
    session.state = 'GREETING';
    session.orderData = {};
    session.selectedProduct = undefined;
  } else {
    await sendTextMessage(whatsappConfig, phone, 'يرجى الرد بـ "نعم" لتأكيد الطلب أو "لا" للإلغاء.');
  }
}

async function handleWithAI(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  session: Session
): Promise<void> {
  const productContext = `المنتجات المتوفرة:\n${await formatProductList(shopId)}`;
  const reply = await getAIResponse(session.messages, productContext);
  await sendTextMessage(whatsappConfig, phone, reply);
  session.messages.push({ role: 'assistant', content: reply });
}
