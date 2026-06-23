import { WhatsAppMessage, Product, Session } from '../types';
import { getSession } from '../services/session';
import { getAIResponse, classifyIntent } from '../services/openai';
import { sendTextMessage, sendImageMessage, sendLocationRequest, WhatsAppConfig } from '../services/whatsapp';
import { getAllProducts, getProductByName, formatProductList, sendProductCatalog } from '../products';
import { generateOrderId, formatPrice, maskPhone } from '../utils/helpers';
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

  // Check if owner — support both regular phone and LID format
  const rawFrom = msg.from; // Could be "966XXXXXXXX" or "123456789@lid"
  const fromDigits = rawFrom.replace(/\D/g, '');
  const ownerPhoneDigits = shop.ownerPhone ? shop.ownerPhone.replace(/\D/g, '') : null;

  let isOwner = false;

  if (shop.ownerJid && rawFrom === shop.ownerJid) {
    // Exact JID match (LID or regular) — most reliable
    isOwner = true;
  } else if (ownerPhoneDigits && fromDigits.endsWith(ownerPhoneDigits)) {
    // Phone number match (regular WhatsApp, non-LID)
    isOwner = true;
    // Auto-save JID for future LID matching
    if (!shop.ownerJid) {
      await prisma.shop.update({ where: { id: shopId }, data: { ownerJid: rawFrom } }).catch(() => {});
      logger.info(`[Agent1] Auto-saved ownerJid: ${maskPhone(rawFrom)} for shop ${shopId}`);
    }
  }

  if (isOwner) {
    logger.info(`[Agent1] Message from OWNER ${maskPhone(rawFrom)} for shop ${shopId}`);
    const session = await getSession(rawFrom, shopId);
    await handleOwnerMessage(rawFrom, shopId, whatsappConfig, msg, session, shop);
    await saveSession(session, shopId);
    return;
  }

  // 1.2 Check if user is blocked
  const isBlocked = await prisma.blockedCustomer.findUnique({
    where: { shopId_phone: { shopId, phone } }
  });
  if (isBlocked) {
    logger.info(`[Agent1] Ignored message from blocked user ${maskPhone(phone)} for shop ${shopId}`);
    return;
  }

  // 2. Load or create Session from DB
  const session = await getSession(phone, shopId);

  logger.info(`[Agent1] Message from ${maskPhone(phone)} for shop ${shop.name} (${shopId}), state: ${session.state}, type: ${msg.type}, botPaused: ${session.botPaused}`);

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
    logger.info(`[Agent1] Bot paused for ${maskPhone(phone)} in shop ${shopId}. Message recorded, no AI response.`);
    return;
  }

  if (msg.type === 'location' && msg.location) {
    await handleLocation(phone, shopId, whatsappConfig, msg.location, session);
    await saveSession(session, shopId);
    return;
  }

  let userText = msg.text?.body || '';
  
  if ((msg.type === 'image' || msg.type === 'document') && session.state === 'AWAITING_BANK_TRANSFER') {
    userText = 'تم التحويل (صورة/ملف مرفق)';
  }

  if (!userText) {
    if (msg.type === 'audio' || msg.type === 'voice' || msg.type === 'ptt') {
      await sendTextMessage(whatsappConfig, phone, 'عذراً، لا أستطيع الاستماع للمقاطع الصوتية حالياً. يرجى كتابة طلبك نصياً 🌹');
    } else if (msg.type !== 'location') {
      await sendTextMessage(whatsappConfig, phone, 'عذراً، لا يمكنني معالجة هذا النوع من الملفات. يرجى مراسلتي نصياً 🌹');
    }
    return;
  }

  // Append user message in-memory
  session.messages.push({ role: 'user', content: userText });

  const intent = await classifyIntent(userText, session.state, shop);
  logger.info(`[Agent1] Intent: ${intent.intent}`);

  if (intent.intent === 'abuse') {
    const reply = 'تم إيقاف الرد الآلي وتحويل محادثتك للإدارة لمراجعة السلوك غير المصرح به. نرجو الانتظار.';
    await sendTextMessage(whatsappConfig, phone, reply);
    session.messages.push({ role: 'assistant', content: reply });
    
    session.botPaused = true;
    await saveSession(session, shopId);

    // Notify Admin
    if (whatsappConfig.adminGroupId) {
      try {
        const adminMsg = `🚨 *تنبيه أمني*: نظام الذكاء الاصطناعي رصد سلوكاً مسيئاً أو غير لائق من الرقم:\n${phone.split('@')[0]}\n\nتم إيقاف البوت تلقائياً لهذا العميل. يرجى الدخول للوحة التحكم لمراجعة المحادثة وحظره إن لزم الأمر.`;
        await sendTextMessage(whatsappConfig, whatsappConfig.adminGroupId, adminMsg);
      } catch (err) {
        logger.error(`[Agent1] Failed to notify admin group about abuse: ${err}`);
      }
    }
    return;
  }

  const lowerText = userText.trim().toLowerCase();
  const isCancelMatch = intent.intent === 'cancel' || ['لا', 'إلغاء', 'الغاء', 'كنسل', 'cancel'].includes(lowerText);
  if (isCancelMatch) {
    let cancelledDbOrder = false;

    // If the user just completed an order (or is awaiting payment) and wants to cancel it.
    if (session.state === 'GREETING' || session.state === 'AWAITING_PAYMENT') {
      const recentOrder = await prisma.order.findFirst({
        where: {
          shopId: shopId,
          customerPhone: phone,
          paymentStatus: { in: ['PENDING', 'CONFIRMED'] },
          timestamp: { gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } // within last 2 hours
        },
        orderBy: { timestamp: 'desc' }
      });

      if (recentOrder) {
        await prisma.order.update({
          where: { id: recentOrder.id },
          data: { paymentStatus: 'CANCELLED' }
        });
        cancelledDbOrder = true;
      }
    }

    if (cancelledDbOrder) {
      await sendTextMessage(whatsappConfig, phone, 'تم إلغاء طلبك بنجاح. يمكنك بدء طلب جديد في أي وقت! 🙏');
    } else {
      await sendTextMessage(whatsappConfig, phone, 'تم إلغاء العملية الحالية. يمكنك البدء من جديد في أي وقت! 🙏');
    }
    
    session.state = 'GREETING';
    session.orderData = {};
    session.selectedProduct = undefined;
    await saveSession(session, shopId);
    return;
  }

  // Human Assistance Request
  const wantsHuman = /موظف|خدمة عملاء|خدمه عملاء|انسان|إنسان|بشر|شخص|اكلم موظف|بكلم موظف|مساعده من موظف|تحدث مع موظف|ابغى موظف|ابي موظف|الدعم الفني|دعم فني/i.test(userText);
  if (wantsHuman) {
    const reply = 'تم إيقاف الرد الآلي وتحويل محادثتك للموظف، سيتم الرد عليك في أقرب وقت. 🌹';
    await sendTextMessage(whatsappConfig, phone, reply);
    session.messages.push({ role: 'assistant', content: reply });
    
    session.botPaused = true;
    await saveSession(session, shopId);

    // Notify Admin
    if (whatsappConfig.adminGroupId) {
      try {
        const adminMsg = `👨‍💼 *تنبيه خدمة عملاء*: العميل يطلب التحدث مع موظف.\nرقم العميل: ${phone.split('@')[0]}\nالاسم: ${session.orderData.customerName || 'غير مسجل'}\n\nتم إيقاف الرد الآلي مؤقتاً لهذه المحادثة لكي تتمكن من الرد عليه.`;
        await sendTextMessage(whatsappConfig, whatsappConfig.adminGroupId, adminMsg);
      } catch (err) {
        logger.error(`[Agent1] Failed to notify admin group about human request: ${err}`);
      }
    }
    return;
  }


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

  // Delivery/pickup timing question → answer deterministically with the shop's real
  // working hours (don't rely on the small model to quote them correctly).
  const asksTiming = /(متى|وقت|موعد|مواعيد|ساعات|كم ساعة|كم يوم|كم ياخذ|كم يأخذ|بكم)/.test(userText);
  const mentionsFulfillment = /(توصيل|التوصيل|توصلون|توصلونه|يوصل|توصل|استلام|الطلب|الدوام|العمل)/.test(userText);
  const asksDeliveryInfo = asksTiming && mentionsFulfillment;
  if (asksDeliveryInfo && session.state !== 'COLLECTING_TIME') {
    const s = shop.deliveryStartHour || '09:00';
    const e = shop.deliveryEndHour || '22:00';
    const msg =
      `🚚 خدمة التوصيل والاستلام متاحة ضمن ساعات العمل: من *${s}* إلى *${e}*.\n` +
      `عند إتمام طلبك ستحدّد الوقت المناسب لك ضمن هذه الفترة، وتختار التوصيل أو الاستلام من المحل. 🌹`;
    await sendTextMessage(whatsappConfig, phone, msg);
    session.messages.push({ role: 'assistant', content: msg });
    await saveSession(session, shopId);
    return;
  }

  // Check Order Status
  const asksOrderStatus = /حالة الطلب|حاله الطلب|وين طلبي|وين الطلب|وش صار|ايش صار|تتبع الطلب|حالة طلبي|متى يوصل طلبي|متابعة الطلب|حالة طلبيتي/i.test(userText);
  if (asksOrderStatus) {
    const lastOrder = await prisma.order.findFirst({
      where: { shopId, customerPhone: phone },
      orderBy: { timestamp: 'desc' },
    });

    if (lastOrder) {
      let statusAr = 'قيد المعالجة ⏳';
      if (lastOrder.orderStatus === 'DELIVERED') statusAr = 'تم التوصيل/الاستلام بنجاح ✅';
      else if (lastOrder.orderStatus === 'CANCELLED') statusAr = 'تم الإلغاء ❌';
      else if (lastOrder.paymentStatus === 'CONFIRMED') statusAr = 'مؤكد وجاري التجهيز 📦';
      else if (lastOrder.paymentStatus === 'PENDING') statusAr = 'بانتظار تأكيد الدفع 💳';

      const msg = `مرحباً بك! 🌹\nحالة طلبك الأخير (رقم: ${lastOrder.id.slice(-4)}) هي:\n*${statusAr}*`;
      await sendTextMessage(whatsappConfig, phone, msg);
      session.messages.push({ role: 'assistant', content: msg });
    } else {
      const msg = `عذراً، لم أتمكن من العثور على طلبات سابقة مسجلة برقمك الحالي. 😕`;
      await sendTextMessage(whatsappConfig, phone, msg);
      session.messages.push({ role: 'assistant', content: msg });
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
    case 'GREETING': {
      // Spam Protection: Limit active orders per customer
      const recentOrdersCount = await prisma.order.count({
        where: {
          shopId,
          customerPhone: phone,
          paymentStatus: { in: ['PENDING', 'CONFIRMED'] },
          timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        }
      });
      
      if (recentOrdersCount >= 3) {
        const spamMsg = 'عذراً، لقد وصلت للحد الأقصى للطلبات قيد التنفيذ اليوم. 🚫\nنرجو انتظار توصيل طلباتك الحالية أو التواصل مع خدمة العملاء للمساعدة.';
        await sendTextMessage(whatsappConfig, phone, spamMsg);
        session.messages.push({ role: 'assistant', content: spamMsg });
        // Pause the bot so the shop owner can review
        session.botPaused = true;
        break;
      }
      await handleGreeting(phone, shopId, whatsappConfig, userText, intent.intent, session);
      break;
    }
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
    case 'COLLECTING_RECIPIENT_PHONE':
      await handleCollectRecipientPhone(phone, shopId, whatsappConfig, userText, session);
      break;
    case 'COLLECTING_FULFILLMENT':
      await handleCollectFulfillment(phone, shopId, whatsappConfig, userText, session);
      break;
    case 'COLLECTING_LOCATION':
      if (intent.intent === 'provide_location' || userText.length > 5) {
        session.orderData.locationUrl = userText.trim();
        session.orderData.fulfillmentType = 'DELIVERY';
        await sendTextMessage(whatsappConfig, phone, 'تم تسجيل العنوان ✅');
        const { askPreferredTime } = require('./agent-1-conversation');
        await askPreferredTime(phone, shopId, whatsappConfig, session, 'التوصيل');
        session.state = 'COLLECTING_TIME';
      } else {
        await sendLocationRequest(whatsappConfig, phone);
      }
      break;
    case 'COLLECTING_TIME':
      await handleCollectTime(phone, shopId, whatsappConfig, userText, session);
      break;
    case 'CONFIRMING_ORDER':
      await handleConfirmation(phone, shopId, whatsappConfig, userText, intent.intent, session, shop);
      break;
    case 'COLLECTING_PAYMENT_METHOD':
      await handlePaymentMethodSelection(phone, shopId, whatsappConfig, userText, session, shop);
      break;
    case 'AWAITING_BANK_TRANSFER':
      await handleAwaitingBankTransfer(phone, shopId, whatsappConfig, userText, session, shop, msg);
      break;
    case 'AWAITING_PAYMENT': {
      const l = userText.trim().toLowerCase();
      const restartWords = ['جديد', 'طلب جديد', 'ابدأ', 'ابدا', 'البداية', 'القائمة', 'الغاء', 'إلغاء', 'الغاء الطلب', 'إلغاء الطلب', 'cancel', 'menu', 'start'];
      if (restartWords.includes(l)) {
        // Spam Protection
        const recentOrdersCount = await prisma.order.count({
          where: {
            shopId,
            customerPhone: phone,
            paymentStatus: { in: ['PENDING', 'CONFIRMED'] },
            timestamp: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }
        });
        if (recentOrdersCount >= 3) {
          const spamMsg = 'عذراً، لقد وصلت للحد الأقصى للطلبات قيد التنفيذ. 🚫\nنرجو التواصل مع خدمة العملاء للمساعدة.';
          await sendTextMessage(whatsappConfig, phone, spamMsg);
          session.messages.push({ role: 'assistant', content: spamMsg });
          session.botPaused = true;
          break;
        }

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
    case 'COMPLETED': {
      const l = userText.trim().toLowerCase();
      const restartWords = ['جديد', 'طلب جديد', 'ابدأ', 'ابدا', 'البداية', 'القائمة', 'menu', 'start'];
      if (restartWords.some(w => l.includes(w)) || intent.intent === 'greeting' || intent.intent === 'browse') {
        session.orderData = {};
        session.selectedProduct = undefined;
        session.state = 'GREETING';
        await handleGreeting(phone, shopId, whatsappConfig, userText, 'greeting', session);
      } else {
        await handleWithAI(phone, shopId, whatsappConfig, session);
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
  let shopName = 'متجرنا';
  let logoUrl: string | null = null;
  
  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { logoUrl: true, name: true } });
    if (shop) {
      shopName = shop.name;
      logoUrl = shop.logoUrl;
    }
  } catch {
    /* ignore */
  }

  const greetingText = `أهلاً وسهلاً بك في ${shopName}! 🌹\n\nيسعدنا خدمتك. دعنا نعرض لك منتجاتنا 🛒`;

  // Branded welcome: send the shop logo first if configured.
  if (logoUrl && logoUrl.trim()) {
    try {
      await sendImageMessage(whatsappConfig, phone, logoUrl, greetingText);
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

  await sendTextMessage(whatsappConfig, phone, greetingText);
  session.messages.push({ role: 'assistant', content: greetingText });
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
  // Extract a product number even from phrasing like "رقم 1" / "المنتج ٢" / "ابغى 3".
  const normalized = text.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  const numMatch = normalized.match(/\d{1,2}/);
  const num = numMatch ? parseInt(numMatch[0], 10) : NaN;
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
  
  if (phone.startsWith('lid')) {
    session.orderData.customerPhone = '';
    const reply = `شكراً ${name} 🙏\n\nفضلاً، ما هو رقم الجوال الخاص بك للتواصل؟`;
    await sendTextMessage(whatsappConfig, phone, reply);
    session.messages.push({ role: 'assistant', content: reply });
    session.state = 'COLLECTING_PHONE';
  } else {
    session.orderData.customerPhone = phone;
    const reply = `شكراً ${name} 🙏\n\nهل الهدية لشخص آخر؟ ما اسم المستلم؟\n(إذا كانت لك شخصياً، اكتب "لي")`;
    await sendTextMessage(whatsappConfig, phone, reply);
    session.messages.push({ role: 'assistant', content: reply });
    session.state = 'COLLECTING_RECIPIENT';
  }
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
  const recipient = text.trim();
  const isMe = /^(لي|انا|أنا|نفسي|حقي)$/i.test(recipient);

  session.orderData.recipientName = isMe ? (session.orderData.customerName || 'نفس العميل') : recipient;

  if (!isMe) {
    const reply = `بما أن الطلب لشخص آخر، ما هو رقم جوال المستلم (للتواصل معه عند التوصيل)؟`;
    await sendTextMessage(whatsappConfig, phone, reply);
    session.messages.push({ role: 'assistant', content: reply });
    session.state = 'COLLECTING_RECIPIENT_PHONE';
    return;
  }

  await askFulfillmentOptions(phone, shopId, whatsappConfig, session);
}

async function handleCollectRecipientPhone(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  session: Session
): Promise<void> {
  session.orderData.recipientPhone = text.trim();
  await askFulfillmentOptions(phone, shopId, whatsappConfig, session);
}

async function askFulfillmentOptions(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  session: Session
): Promise<void> {
  // بناء خيارات الاستلام حسب إعدادات المتجر
  const shopSettings = await prisma.shop.findUnique({ where: { id: shopId } });
  const canDeliver = shopSettings?.enableDelivery ?? true;
  const canPickup = shopSettings?.enablePickup ?? true;

  if (!canDeliver && !canPickup) {
    // كلاهما معطّل — حالة غير طبيعية
    const reply = 'عذراً، خيارات الاستلام غير متاحة حالياً. يرجى التواصل معنا لاحقاً.';
    await sendTextMessage(whatsappConfig, phone, reply);
    session.messages.push({ role: 'assistant', content: reply });
    return;
  }

  let replyOptions = 'رائع! ✨\nكيف تفضّل استلام طلبك؟\n\n';
  const opts: string[] = [];
  if (canDeliver) opts.push('🚚 *1* - توصيل إلى موقعك');
  if (canPickup) opts.push('🏬 *' + (canDeliver ? '2' : '1') + '* - استلام من المحل');
  replyOptions += opts.join('\n');
  if (canDeliver && canPickup) replyOptions += '\n\n(اكتب 1 أو 2)';

  await sendTextMessage(whatsappConfig, phone, replyOptions);
  session.messages.push({ role: 'assistant', content: replyOptions });
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
  const t = text.trim();
  if (!t) {
    await sendTextMessage(whatsappConfig, phone, 'يرجى كتابة الوقت المناسب لك (مثال: 6 مساءً). 🕒');
    return;
  }
  
  const hasTimeKeywords = /[٠-٩0-9]|ساعة|ساعه|صباح|مساء|ظهر|عصر|مغرب|عشا|ص|م|am|pm|الان|الآن|فور/i.test(t);
  if (!hasTimeKeywords || t.length > 50) {
    await sendTextMessage(whatsappConfig, phone, 'عذراً، لم أتمكن من فهم الوقت. يرجى كتابة وقت محدد (مثال: 5 العصر، 10 الصباح، أو الآن). 🕒');
    return;
  }

  // Accept the customer's stated time as-is (Arabic time phrasing is too varied to
  // validate reliably; the allowed window was already shown, and the merchant
  // confirms the order). Store it for the summary + admin notice.
  session.orderData.preferredTime = t;
  await sendOrderSummary(phone, shopId, whatsappConfig, session);
  session.state = 'CONFIRMING_ORDER';
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
  const recipientPhoneLine = session.orderData.recipientPhone ? `📞 جوال المستلم: ${session.orderData.recipientPhone}\n` : '';
  const summary =
    `📋 *ملخص طلبك:*\n\n` +
    `🌹 المنتج: ${session.orderData.product}\n` +
    `💰 السعر: ${formatPrice(session.orderData.price || 0)}\n` +
    `👤 الاسم: ${session.orderData.customerName}\n` +
    `🎁 المستلم: ${session.orderData.recipientName}\n` +
    recipientPhoneLine +
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
  session: Session,
  shop: any
): Promise<void> {
  const lower = text.trim().toLowerCase();

  if (intent === 'confirm' || lower === 'نعم' || lower === 'اي' || lower === 'تمام' || lower === 'أكيد') {
    if (shop.subscriptionPlan === 'SILVER') {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);
      const ordersCount = await prisma.order.count({
        where: { shopId, timestamp: { gte: startOfMonth } }
      });
      if (ordersCount >= 500) {
        await sendTextMessage(whatsappConfig, phone, 'عذراً، وصل المتجر للحد الأقصى للطلبات هذا الشهر. يرجى مراجعة إدارة المتجر لاحقاً.');
        return;
      }
    }

    const methods = [];
    if (shop.enableOnlinePayment) methods.push({ id: 'ONLINE', label: 'دفع إلكتروني (بطاقة/أبل باي)' });
    if (shop.enableCashPayment) methods.push({ id: 'CASH', label: 'دفع نقداً (عند الاستلام)' });
    if (shop.enableBankTransfer) methods.push({ id: 'BANK', label: 'تحويل بنكي' });

    if (methods.length === 0) {
      await sendTextMessage(whatsappConfig, phone, 'عذراً، لا يوجد خيارات دفع متاحة حالياً. يرجى التواصل مع الإدارة.');
      return;
    }

    if (methods.length === 1) {
      await proceedWithPaymentMethod(phone, shopId, whatsappConfig, session, shop, methods[0].id);
    } else {
      let msg = 'الرجاء اختيار طريقة الدفع:\n\n';
      methods.forEach((m, idx) => {
        msg += `${idx + 1} - ${m.label}\n`;
      });
      session.orderData.availablePaymentMethods = methods.map(m => m.id);
      await sendTextMessage(whatsappConfig, phone, msg);
      session.state = 'COLLECTING_PAYMENT_METHOD';
    }
  } else if (intent === 'cancel' || lower === 'لا' || lower === 'إلغاء') {
    await sendTextMessage(whatsappConfig, phone, 'تم إلغاء الطلب. يمكنك البدء من جديد في أي وقت! 🙏');
    session.state = 'GREETING';
    session.orderData = {};
    session.selectedProduct = undefined;
  } else {
    await sendTextMessage(whatsappConfig, phone, 'يرجى الرد بـ "نعم" لتأكيد الطلب أو "لا" للإلغاء.');
  }
}

async function handlePaymentMethodSelection(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  session: Session,
  shop: any
): Promise<void> {
  const methods = session.orderData.availablePaymentMethods || [];
  const choice = parseInt(text.trim());

  if (isNaN(choice) || choice < 1 || choice > methods.length) {
    await sendTextMessage(whatsappConfig, phone, 'الرجاء إدخال رقم صحيح لخيارات الدفع المتاحة.');
    return;
  }

  const selectedMethod = methods[choice - 1];
  await proceedWithPaymentMethod(phone, shopId, whatsappConfig, session, shop, selectedMethod);
}

async function proceedWithPaymentMethod(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  session: Session,
  shop: any,
  methodId: string
): Promise<void> {
  const orderId = generateOrderId();
  session.orderData.id = orderId;
  session.orderData.shopId = shopId;
  session.orderData.timestamp = new Date().toISOString();
  session.orderData.paymentStatus = 'PENDING';
  session.orderData.paymentMethod = methodId; // Save selected method for later

  await addOrder({
    id: orderId,
    shopId: shopId,
    timestamp: session.orderData.timestamp!,
    customerName: session.orderData.customerName || '',
    customerPhone: session.orderData.customerPhone || phone,
    recipientName: session.orderData.recipientName || '',
    product: session.orderData.product || '',
    price: session.orderData.price || 0,
    paymentStatus: methodId === 'CASH' ? 'CONFIRMED' : 'PENDING',
    locationUrl: session.orderData.locationUrl || '',
    fulfillmentType: session.orderData.fulfillmentType,
    preferredTime: session.orderData.preferredTime,
    cardLast4: methodId === 'CASH' ? 'CASH' : (methodId === 'BANK' ? 'BANK' : ''),
    productImageUrl: session.orderData.productImageUrl || '',
    notes: '',
    productId: session.orderData.productId,
    recipientPhone: session.orderData.recipientPhone,
  });

  const isPickup = session.orderData.fulfillmentType === 'PICKUP';
  const timeLine = session.orderData.preferredTime ? `\nالوقت المطلوب: ${session.orderData.preferredTime}` : '';

  if (methodId === 'ONLINE') {
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
  } else if (methodId === 'BANK') {
    await sendTextMessage(whatsappConfig, phone, 'لإتمام طلبك، يرجى التحويل لأحد الحسابات البنكية التالية:');
    try {
      const accounts = JSON.parse(shop.bankAccounts || "[]");
      if (accounts.length === 0) {
        await sendTextMessage(whatsappConfig, phone, 'لا توجد حسابات بنكية مضافة حالياً. يرجى التواصل مع الإدارة.');
      } else {
        for (const acc of accounts) {
          const accNameStr = acc.accountName ? `\n👤 المستفيد: ${acc.accountName}` : '';
          const infoMsg = `🏦 بنك: *${acc.bankName}*${accNameStr}\n👇 (يمكنك نسخ الأرقام أدناه)`;
          await sendTextMessage(whatsappConfig, phone, infoMsg);
          
          if (acc.accountNumber) {
            await sendTextMessage(whatsappConfig, phone, acc.accountNumber);
          }
          if (acc.iban) {
            await sendTextMessage(whatsappConfig, phone, acc.iban);
          }
        }
      }
    } catch (e) {
      await sendTextMessage(whatsappConfig, phone, 'خطأ في تحميل الحسابات البنكية.');
    }
    await sendTextMessage(whatsappConfig, phone, 'بعد التحويل، أرسل كلمة *تم التحويل* لكي نتمكن من مراجعة الطلب وتأكيده. 🌹');
    session.state = 'AWAITING_BANK_TRANSFER';
  } else if (methodId === 'CASH') {
    const summaryMsg =
      `تم تأكيد طلبك بنجاح! ✅\n\n` +
      `رقم الطلب: ${orderId}\n` +
      `المبلغ: ${session.orderData.price} ريال (الدفع عند الاستلام)\n` +
      (isPickup ? `📦 الاستلام: من المحل${timeLine}` : `🚚 التوصيل: إلى موقعك${timeLine}`) +
      `\n\nشكراً لتسوقك معنا! 🌹`;

    await sendTextMessage(whatsappConfig, phone, summaryMsg);
    
    const { sendToAdminGroup } = require('../services/whatsapp');
    const adminMsg =
      `🆕 NEW ORDER (${shop.name})\n` +
      `━━━━━━━━━━━━━━\n` +
      `📱 Customer Phone: ${phone}\n` +
      `👤 Customer Name: ${session.orderData.customerName || ''}\n` +
      `🌹 Product: ${session.orderData.product || 'N/A'}\n` +
      `💰 Price: ${session.orderData.price} SAR (CASH)\n` +
      `${isPickup ? '🏬 الاستلام: من المحل' : '🚚 التوصيل: إلى الموقع'}${session.orderData.preferredTime ? ' | الوقت: ' + session.orderData.preferredTime : ''}\n` +
      (!isPickup && session.orderData.locationUrl && session.orderData.locationUrl.startsWith('http') ? `📍 الموقع: ${session.orderData.locationUrl}\n` : '') +
      `✅ Payment: CASH ON DELIVERY\n` +
      `📋 Order ID: ${orderId}\n` +
      `━━━━━━━━━━━━━━`;
      
    try {
      await sendToAdminGroup(whatsappConfig, adminMsg);
    } catch (err) {
      logger.warn(`[Agent1] Failed to send admin notification for COD order ${orderId}: ${err}`);
    }
    
    session.state = 'COMPLETED';
    session.orderData = {};
    session.selectedProduct = undefined;
  }
}

async function handleAwaitingBankTransfer(
  phone: string,
  shopId: string,
  whatsappConfig: WhatsAppConfig,
  text: string,
  session: Session,
  shop: any,
  msg: any
): Promise<void> {
  const lower = text.trim().toLowerCase();
  
  if (lower.includes('تم التحويل') || lower.includes('حولت') || lower.includes('تم') || msg.type === 'image' || msg.type === 'document') {
    await sendTextMessage(whatsappConfig, phone, 'شكراً لك! 🌹\nسنقوم بمراجعة التحويل وتأكيد طلبك في أقرب وقت. سيصلك إشعار بالتأكيد.');
    
    const { sendToAdminGroup, forwardMediaToAdminGroup } = require('../services/whatsapp');
    const isPickup = session.orderData.fulfillmentType === 'PICKUP';
    const hasMedia = msg.type === 'image' || msg.type === 'document';
    
    const adminMsg =
      `🏦 إشعار تحويل بنكي (${shop.name})\n` +
      `━━━━━━━━━━━━━━\n` +
      `أكد العميل تحويل مبلغ الطلب.\n` +
      `📱 هاتف العميل: ${phone}\n` +
      `👤 اسم العميل: ${session.orderData.customerName || ''}\n` +
      `💰 المبلغ: ${session.orderData.price} SAR\n` +
      `📋 رقم الطلب: ${session.orderData.id}\n` +
      `يرجى مراجعة الحساب البنكي وتأكيد الطلب من لوحة التحكم.\n` +
      `━━━━━━━━━━━━━━`;
      
    try {
      if (hasMedia) {
        const mediaId = msg.type === 'image' ? msg.image?.id : msg.document?.id;
        if (mediaId) {
          await forwardMediaToAdminGroup(whatsappConfig, mediaId, msg.type, adminMsg);
        } else {
          await sendToAdminGroup(whatsappConfig, adminMsg + '\n(ملاحظة: العميل أرسل مرفقاً ولكن تعذر الحصول على هويته، يرجى مراجعة المحادثة الأصلية).');
        }
      } else {
        await sendToAdminGroup(whatsappConfig, adminMsg);
      }
    } catch (err) {
      logger.warn(`[Agent1] Failed to notify admin group about bank transfer: ${err}`);
    }
    
    session.state = 'COMPLETED';
    session.orderData = {};
    session.selectedProduct = undefined;
  } else {
    await sendTextMessage(whatsappConfig, phone, 'بعد الانتهاء من التحويل البنكي، يرجى الرد بكلمة *تم التحويل* لمراجعة العملية وتأكيد طلبك.');
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
