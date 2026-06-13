import { WhatsAppMessage, Product, Session } from '../types';
import { getSession } from '../services/session';
import { getAIResponse, classifyIntent } from '../services/openai';
import { sendTextMessage, sendImageMessage, sendLocationRequest, WhatsAppConfig } from '../services/whatsapp';
import { getAllProducts, getProductByName, formatProductList, sendProductCatalog } from '../products';
import { generateOrderId, formatPrice } from '../utils/helpers';
import { processPayment } from './agent-2-payment';
import { addOrder } from './agent-3-excel';
import prisma from '../services/db';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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
    whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
    shopId: shop.id,
    token: shop.whatsappToken || '',
    phoneId: shop.whatsappPhoneId || '',
    adminGroupId: shop.whatsappAdminGroupId,
    ultramsgInstanceId: shop.ultramsgInstanceId,
    ultramsgToken: shop.ultramsgToken,
  };

  // 1.1 Check if subscription is expired or suspended
  const isExpired = shop.subscriptionEnd && new Date() > new Date(shop.subscriptionEnd);
  if (isExpired || shop.subscriptionStatus === 'EXPIRED' || shop.subscriptionStatus === 'SUSPENDED') {
    // Only reply if it was a text message (avoid infinite loops on status changes)
    if (msg.type === 'text' && msg.text?.body) {
      await sendTextMessage(whatsappConfig, phone, "نعتذر منك، خدمة الرد الآلي متوقفة حالياً للتجديد. سيتواصل معك فريق الدعم قريباً.");
    }
    logger.warn(`[Agent1] Message blocked. Subscription expired or suspended for shop: ${shop.name} (${shop.id})`);
    return;
  }

  // 2. Fetch session from DB
  const session = await getSession(phone, shopId);

  // Check if owner
  const cleanPhone = phone.replace(/\D/g, '');
  const cleanOwnerPhone = shop.ownerPhone ? shop.ownerPhone.replace(/\D/g, '') : null;
  const isOwner = cleanOwnerPhone && cleanPhone === cleanOwnerPhone;

  if (isOwner) {
    logger.info(`[Agent1] Message from OWNER ${phone} for shop ${shopId}`);
    await handleOwnerMessage(phone, shopId, whatsappConfig, msg, session, shop);
    await saveSession(session, shopId);
    return;
  }

  logger.info(`[Agent1] Message from ${phone} for shop ${shop.name} (${shopId}), state: ${session.state}, type: ${msg.type}, botPaused: ${session.botPaused}`);

  // 2.1 If bot is paused (manual intervention mode), only record the message and exit
  if (session.botPaused) {
    if (msg.type === 'location' && msg.location) {
      const locationUrl = `https://maps.google.com/maps?q=${msg.location.latitude},${msg.location.longitude}`;
      session.messages.push({ role: 'user', content: `📍 موقع: ${locationUrl}` });
    } else if (msg.text?.body) {
      session.messages.push({ role: 'user', content: msg.text.body });
    }
    // Save message to DB without triggering AI response
    await saveSession(session, shopId);
    logger.info(`[Agent1] Bot paused for ${phone} in shop ${shopId}. Message recorded, no AI response.`);
    return;
  }

  if (msg.type === 'location' && msg.location) {
    await handleLocation(phone, shopId, whatsappConfig, msg.location, session);
    await saveSession(session, shopId);
    return;
  }

  const userText = msg.text?.body || '';
  if (!userText) return;

  // Append user message in-memory
  session.messages.push({ role: 'user', content: userText });

  const intent = await classifyIntent(userText, session.state, shop);
  logger.info(`[Agent1] Intent: ${intent.intent}`);

  // Image request: send the ACTUAL product image(s) instead of letting the text AI
  // wrongly claim there is no image.
  const wantsImage = /صور[ةه]|الصور|اشوف|أشوف|أبي اشوف|ابي اشوف|شكله|شكلها|ورّني|ورني|أرني|ارني|بالصور|picture|image|photo/i.test(userText);
  if (wantsImage) {
    const all = await getAllProducts(shopId);
    let target = session.selectedProduct || null;
    if (!target && all.length) {
      const digits = userText.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
      const nm = digits.match(/\d{1,2}/);
      if (nm) { const i = parseInt(nm[0], 10); if (i >= 1 && i <= all.length) target = all[i - 1]; }
      if (!target) target = all.find((p) => userText.includes(p.name)) || (await getProductByName(shopId, userText.trim()));
    }
    if (target && target.imageUrl && target.imageUrl.trim()) {
      const idx = all.findIndex((p) => p.id === target!.id) + 1;
      const cap = `🌹 *${target.name}*\n💰 ${target.price} ريال` + (target.description ? `\n📝 ${target.description}` : '') + (idx > 0 ? `\n\nلطلبه أرسل الرقم: *${idx}*` : '');
      try { await sendImageMessage(whatsappConfig, phone, target.imageUrl, cap); }
      catch { await sendTextMessage(whatsappConfig, phone, cap); }
      session.messages.push({ role: 'assistant', content: `صورة ${target.name}` });
    } else {
      const r = await sendProductCatalog(shopId, whatsappConfig, phone, sendTextMessage, sendImageMessage);
      session.messages.push({ role: 'assistant', content: r });
    }
    await saveSession(session, shopId);
    return;
  }

  // Intelligent Q&A overlay: if the customer asks an open question at any point in
  // the flow, answer it with AI (product + delivery aware) instead of the scripted
  // reply, then keep them in the same step so the order flow resumes naturally.
  const isQuestion =
    /[؟?]/.test(userText) ||
    /^\s*(كم|هل|وش|ايش|أيش|إيش|متى|اين|أين|وين|كيف|ليه|ليش|ماهي|ما هي|ما هو|عندكم|عندك|في عندكم|تقدر|ممكن|do you|how|what|when|where)/i.test(userText.trim());
  const aiAnswerStates = ['BROWSING', 'SELECTING_PRODUCT', 'COLLECTING_NAME', 'COLLECTING_PHONE', 'COLLECTING_RECIPIENT', 'COLLECTING_FULFILLMENT', 'COLLECTING_TIME', 'CONFIRMING_ORDER'];
  if (isQuestion && intent.intent !== 'confirm' && intent.intent !== 'cancel' && aiAnswerStates.includes(session.state)) {
    await handleWithAI(phone, shopId, whatsappConfig, session);
    await saveSession(session, shopId);
    return;
  }

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
    case 'COLLECTING_FULFILLMENT':
      await handleCollectFulfillment(phone, shopId, whatsappConfig, userText, session);
      break;
    case 'COLLECTING_LOCATION':
      await sendLocationRequest(whatsappConfig, phone);
      break;
    case 'COLLECTING_TIME':
      await handleCollectTime(phone, shopId, whatsappConfig, userText, session);
      break;
    case 'CONFIRMING_ORDER':
      await handleConfirmation(phone, shopId, whatsappConfig, userText, intent.intent, session);
      break;
    case 'AWAITING_PAYMENT': {
      const l = userText.trim().toLowerCase();
      const restartWords = ['جديد', 'طلب جديد', 'ابدأ', 'ابدا', 'البداية', 'القائمة', 'الغاء', 'إلغاء', 'الغاء الطلب', 'إلغاء الطلب', 'cancel', 'menu', 'start'];
      if (restartWords.includes(l)) {
        // Let the customer escape a stuck/abandoned payment and start over.
        session.orderData = {};
        session.selectedProduct = undefined;
        session.state = 'GREETING';
        await handleGreeting(phone, shopId, whatsappConfig, userText, 'greeting', session);
      } else {
        await sendTextMessage(
          whatsappConfig,
          phone,
          'طلبك السابق ما زال بانتظار الدفع عبر الرابط المرسل. 💳\n\nلبدء *طلب جديد* اكتب كلمة: *جديد* 🆕'
        );
      }
      break;
    }
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
  // Branded welcome: send the shop logo first if configured.
  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { logoUrl: true, name: true } });
    const greetingText = `أهلاً وسهلاً بك في ${shop?.name || 'متجرنا'}! 🌹\n\nيسعدنا خدمتك. دعنا نعرض لك منتجاتنا 🛒`;
    if (shop?.logoUrl && shop.logoUrl.trim()) {
      try {
        await sendImageMessage(whatsappConfig, phone, shop.logoUrl, greetingText);
        session.messages.push({ role: 'assistant', content: greetingText });
        session.state = 'BROWSING';
        const catalogResult = await sendProductCatalog(shopId, whatsappConfig, phone, sendTextMessage, sendImageMessage);
        session.messages.push({ role: 'assistant', content: catalogResult });
        session.state = 'SELECTING_PRODUCT';
        return;
      } catch {
        /* logo send failed — fall through to text greeting */
      }
    }
  } catch {
    /* ignore */
  }

  const greeting = 'أهلاً وسهلاً بك في متجرنا! 🌹\n\nيسعدنا خدمتك. دعنا نعرض لك منتجاتنا 🛒';

  await sendTextMessage(whatsappConfig, phone, greeting);
  session.messages.push({ role: 'assistant', content: greeting });
  session.state = 'BROWSING';

  const catalogResult = await sendProductCatalog(shopId, whatsappConfig, phone, sendTextMessage, sendImageMessage);
  session.messages.push({ role: 'assistant', content: catalogResult });
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
  const catalogResult = await sendProductCatalog(shopId, whatsappConfig, phone, sendTextMessage, sendImageMessage);
  session.messages.push({ role: 'assistant', content: catalogResult });
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

  // Check product availability and stock
  if (!selected.available || (selected.stock !== undefined && selected.stock <= 0)) {
    const outOfStockMsg = `عذراً، هذا المنتج (${selected.name}) غير متوفر حالياً بنفاد الكمية! ❌\n\nيرجى اختيار منتج آخر من القائمة.`;
    await sendTextMessage(whatsappConfig, phone, outOfStockMsg);
    session.messages.push({ role: 'assistant', content: outOfStockMsg });
    return;
  }

  session.selectedProduct = selected;
  session.orderData.product = selected.name;
  session.orderData.price = selected.price;
  session.orderData.productImageUrl = selected.imageUrl;
  session.orderData.productId = selected.id;

  const confirmation = `✨ *اختيار ممتاز!* ✨\n` +
    `━━━━━━━━━━━━━━\n` +
    `🌹 *${selected.name}*\n` +
    (selected.description ? `📝 ${selected.description}\n` : '') +
    `💰 *السعر: ${formatPrice(selected.price)}*\n` +
    `━━━━━━━━━━━━━━\n\n` +
    `لإتمام الطلب، أحتاج بعض المعلومات.\n` +
    `ما اسمك الكريم؟ 🙏`;

  if (selected.imageUrl && selected.imageUrl.trim() !== '') {
    try {
      await sendImageMessage(whatsappConfig, phone, selected.imageUrl, confirmation);
    } catch (err) {
      await sendTextMessage(whatsappConfig, phone, confirmation);
    }
  } else {
    await sendTextMessage(whatsappConfig, phone, confirmation);
  }
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

  const reply = 'رائع! ✨\nكيف تفضّل استلام طلبك؟\n\n🚚 *1* - توصيل إلى موقعك\n🏬 *2* - استلام من المحل\n\n(اكتب 1 أو 2)';
  await sendTextMessage(whatsappConfig, phone, reply);
  session.messages.push({ role: 'assistant', content: reply });
  session.state = 'COLLECTING_FULFILLMENT';
}

// Ask the customer for a preferred time within the shop's allowed window.
async function askPreferredTime(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  session: Session,
  kind: string
): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  const s = shop?.deliveryStartHour || '09:00';
  const e = shop?.deliveryEndHour || '22:00';
  const msg = `🕒 ما الوقت المناسب لـ${kind}؟\n\nيرجى اختيار وقت ضمن ساعات العمل: من *${s}* إلى *${e}*\n(مثال: 6 مساءً)`;
  await sendTextMessage(whatsappConfig, phone, msg);
  session.messages.push({ role: 'assistant', content: msg });
}

// Choose delivery vs pickup.
async function handleCollectFulfillment(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  session: Session
): Promise<void> {
  const t = text.trim().toLowerCase();
  const isPickup = /استلام|المحل|أستلم|اخذه|آخذه|بنفسي|pickup|(^|\s)2(\s|$)|٢|الثاني|الثانيه|الثانية/.test(t);
  const isDelivery = /توصيل|ديليفري|delivery|يوصل|وصلوه|(^|\s)1(\s|$)|١|الاول|الأول|الاولى/.test(t);

  if (isPickup && !isDelivery) {
    session.orderData.fulfillmentType = 'PICKUP';
    session.orderData.locationUrl = 'استلام من المحل';
    await askPreferredTime(phone, shopId, whatsappConfig, session, 'الاستلام من المحل');
    session.state = 'COLLECTING_TIME';
  } else if (isDelivery) {
    session.orderData.fulfillmentType = 'DELIVERY';
    const reply = 'ممتاز! 📍\nيرجى إرسال موقع التوصيل عبر واتساب.\nاضغط على 📎 ثم اختر "الموقع".';
    await sendTextMessage(whatsappConfig, phone, reply);
    session.messages.push({ role: 'assistant', content: reply });
    session.state = 'COLLECTING_LOCATION';
  } else {
    await sendTextMessage(whatsappConfig, phone, 'يرجى الاختيار: *1* للتوصيل 🚚 أو *2* للاستلام من المحل 🏬');
  }
}

// Capture preferred time (best-effort window check) then show the summary.
async function handleCollectTime(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  session: Session
): Promise<void> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  const within = isTimeWithinWindow(text, shop?.deliveryStartHour || '09:00', shop?.deliveryEndHour || '22:00');
  if (within === false) {
    await sendTextMessage(
      whatsappConfig,
      phone,
      `عذراً، هذا الوقت خارج ساعات العمل (من ${shop?.deliveryStartHour || '09:00'} إلى ${shop?.deliveryEndHour || '22:00'}). يرجى اختيار وقت ضمن هذا النطاق. 🕒`
    );
    return; // stay in COLLECTING_TIME
  }
  session.orderData.preferredTime = text.trim();
  await sendOrderSummary(phone, shopId, whatsappConfig, session);
  session.state = 'CONFIRMING_ORDER';
}

// Best-effort: returns false ONLY when a clearly-parsed time falls outside the
// window; otherwise true (accept) — Arabic time phrasing is too varied to reject safely.
function isTimeWithinWindow(text: string, start: string, end: string): boolean {
  const digits = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const m = digits.match(/(\d{1,2})(?:\s*[:٫.]\s*(\d{2}))?/);
  if (!m) return true;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (isNaN(h) || h > 23) return true;
  const pm = /(مساء|مساءً|ليل|عصر|العصر|المغرب|pm)/i.test(text);
  const am = /(صباح|صباحاً|am|الفجر|الضحى)/i.test(text);
  if (h <= 12) {
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
  }
  const toMin = (hm: string) => { const [a, b] = hm.split(':').map((x) => parseInt(x, 10)); return a * 60 + (b || 0); };
  const cur = h * 60 + min;
  const s = toMin(start), e = toMin(end);
  if (s === e) return true;
  return cur >= s && cur <= e;
}

// Final order summary (delivery or pickup) before confirmation.
async function sendOrderSummary(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  session: Session
): Promise<void> {
  const isPickup = session.orderData.fulfillmentType === 'PICKUP';
  const fulfillmentLine = isPickup ? '🏬 الاستلام: من المحل' : '🚚 التوصيل: إلى موقعك';
  const locationLine = isPickup ? '' : '📍 الموقع: تم الاستلام\n';
  const summary =
    `📋 *ملخص طلبك:*\n\n` +
    `🌹 المنتج: ${session.orderData.product}\n` +
    `💰 السعر: ${formatPrice(session.orderData.price || 0)}\n` +
    `👤 الاسم: ${session.orderData.customerName}\n` +
    `🎁 المستلم: ${session.orderData.recipientName}\n` +
    `${fulfillmentLine}\n` +
    locationLine +
    `🕒 الوقت المطلوب: ${session.orderData.preferredTime || '-'}\n\n` +
    `هل تؤكد الطلب؟ (نعم / لا)`;
  await sendTextMessage(whatsappConfig, phone, summary);
  session.messages.push({ role: 'assistant', content: summary });
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
  session.orderData.fulfillmentType = 'DELIVERY';

  // Location received → now ask for the preferred delivery time within the window.
  await sendTextMessage(whatsappConfig, phone, 'تم استلام الموقع ✅');
  await askPreferredTime(phone, shopId, whatsappConfig, session, 'التوصيل');
  session.state = 'COLLECTING_TIME';
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
      fulfillmentType: session.orderData.fulfillmentType,
      preferredTime: session.orderData.preferredTime,
      cardLast4: '',
      productImageUrl: session.orderData.productImageUrl || '',
      notes: '',
      productId: session.orderData.productId,
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
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) {
    logger.error(`[Agent1] Shop not found in handleWithAI: ${shopId}`);
    return;
  }
  // Rich context so the AI answers accurately about products, prices, delivery,
  // and (if mid-order) gently steers the customer back to completing their order.
  const stepHint: Record<string, string> = {
    SELECTING_PRODUCT: 'العميل يتصفّح المنتجات؛ بعد الإجابة شجّعه على اختيار رقم المنتج.',
    COLLECTING_NAME: 'نحن بانتظار اسم العميل؛ بعد الإجابة اطلب اسمه بلطف.',
    COLLECTING_RECIPIENT: 'نحن بانتظار اسم المستلم؛ بعد الإجابة اطلب اسم المستلم.',
    CONFIRMING_ORDER: 'الطلب بانتظار تأكيد العميل (نعم/لا)؛ بعد الإجابة اطلب التأكيد.',
  };
  const productContext =
    `متجر: ${shop.name}\n` +
    `ساعات التوصيل/الاستلام: من ${shop.deliveryStartHour} إلى ${shop.deliveryEndHour}\n` +
    `المنتجات المتوفرة وأسعارها:\n${await formatProductList(shopId)}\n` +
    (stepHint[session.state] ? `\nملاحظة للسياق: ${stepHint[session.state]}` : '');
  const reply = await getAIResponse(session.messages, productContext, shop);
  await sendTextMessage(whatsappConfig, phone, reply);
  session.messages.push({ role: 'assistant', content: reply });
}

async function handleOwnerMessage(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  msg: WhatsAppMessage,
  session: Session,
  shop: any
): Promise<void> {
  // If owner sends an image
  if (msg.type === 'image' && msg.image?.buffer) {
    const uploadsDir = path.join(__dirname, '../../public/uploads/products');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    
    const ext = msg.image.mime_type.split('/')[1] || 'jpeg';
    const filename = `${shopId}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(uploadsDir, filename), msg.image.buffer);
    
    const imageUrl = `/uploads/products/${filename}`;
    
    session.orderData = { ...session.orderData, tempProductImageUrl: imageUrl };
    session.state = 'OWNER_COLLECTING_PRODUCT_NAME';
    
    await sendTextMessage(whatsappConfig, phone, "تم استلام صورة المنتج بنجاح! 📸\n\nما هو اسم هذا المنتج؟");
    return;
  }
  
  const text = msg.text?.body || '';
  if (!text) return;

  if (text.trim() === 'إلغاء' || text.trim() === 'الغاء') {
    session.state = 'GREETING';
    session.orderData = {};
    await sendTextMessage(whatsappConfig, phone, "تم إلغاء إضافة المنتج. يمكنك إرسال صورة جديدة في أي وقت للإضافة.");
    return;
  }
  
  switch (session.state) {
    case 'OWNER_COLLECTING_PRODUCT_NAME':
      session.orderData = { ...session.orderData, tempProductName: text.trim() };
      session.state = 'OWNER_COLLECTING_PRODUCT_PRICE';
      await sendTextMessage(whatsappConfig, phone, `تم حفظ الاسم: ${text.trim()}\n\nكم سعر المنتج؟ (بالأرقام فقط)`);
      break;
      
    case 'OWNER_COLLECTING_PRODUCT_PRICE':
      const price = parseFloat(text.replace(/[^\d.]/g, ''));
      if (isNaN(price)) {
        await sendTextMessage(whatsappConfig, phone, "يرجى إدخال السعر كـ رقم صحيح (مثال: 50)");
        return;
      }
      session.orderData = { ...session.orderData, tempProductPrice: price };
      session.state = 'OWNER_COLLECTING_PRODUCT_DESC';
      await sendTextMessage(whatsappConfig, phone, `تم حفظ السعر: ${price}\n\nاكتب وصفاً قصيراً للمنتج (أو أرسل "تخطي" إذا لم يكن هناك وصف)`);
      break;
      
    case 'OWNER_COLLECTING_PRODUCT_DESC':
      const desc = text.trim() === 'تخطي' ? '' : text.trim();
      
      try {
        await prisma.product.create({
          data: {
            shopId,
            name: session.orderData.tempProductName as string,
            price: session.orderData.tempProductPrice as number,
            description: desc,
            imageUrl: session.orderData.tempProductImageUrl as string,
            category: 'عام',
            available: true,
            stock: 10
          }
        });
        await sendTextMessage(whatsappConfig, phone, "🎉 تم إضافة المنتج إلى الكتالوج بنجاح!\nيمكنك إرسال صورة منتج آخر لإضافته.");
      } catch (e: any) {
        logger.error(`[Owner Flow] Failed to save product: ${e.message}`);
        await sendTextMessage(whatsappConfig, phone, "حدث خطأ أثناء حفظ المنتج. يرجى المحاولة مرة أخرى.");
      }
      
      session.state = 'GREETING';
      session.orderData = {};
      break;
      
    default:
      await sendTextMessage(whatsappConfig, phone, "أهلاً بك يا مدير المتجر 👑\nلإضافة منتج جديد، فقط أرسل صورته هنا وسأساعدك في إضافته للكتالوج.");
      break;
  }
}
