// eslint-disable-next-line @typescript-eslint/no-var-requires
const TelegramBot = require('node-telegram-bot-api');
import prisma from './db';
import logger from '../utils/logger';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';

// -------------------------------------------------------------------
// حالات محادثة المالك عبر التلجرام (في الذاكرة)
// -------------------------------------------------------------------
interface OwnerSession {
  shopId: string;
  shopName: string;
  state: 'IDLE' | 'WAITING_NAME' | 'WAITING_PRICE' | 'WAITING_DESC' | 'WAITING_STOCK';
  tempImageUrl?: string;
  tempName?: string;
  tempPrice?: number;
  tempDesc?: string;
}

const ownerSessions = new Map<string, OwnerSession>();
let bot: any = null;

export function initTelegramBot(token: string): void {
  if (bot) return;

  bot = new TelegramBot(token, { polling: true });
  logger.info('[Telegram] Bot started successfully');

  // -------------------------------------------------------------------
  // /start
  // -------------------------------------------------------------------
  bot.onText(/\/start/, async (msg: any) => {
    const chatId = String(msg.chat.id);
    const firstName = msg.from?.first_name || 'مدير';
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });

    if (shop) {
      bot.sendMessage(chatId,
        `مرحباً ${firstName}! متجرك: *${shop.name}*\n\n` +
        `📸 أرسل صورة منتج لإضافته\n` +
        `📋 /products — قائمة المنتجات\n` +
        `⚙️ /settings — إعدادات المتجر\n` +
        `❌ /cancel — إلغاء`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    bot.sendMessage(chatId,
      `مرحباً ${firstName}! 👋\n\n` +
      `لربط حسابك أرسل:\n\`/link اسم_المستخدم كلمة_المرور\``,
      { parse_mode: 'Markdown' }
    );
  });

  // -------------------------------------------------------------------
  // /link
  // -------------------------------------------------------------------
  bot.onText(/\/link (.+)/, async (msg: any, match: any) => {
    const chatId = String(msg.chat.id);
    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) {
      bot.sendMessage(chatId, '❌ الصيغة: `/link اسم_المستخدم كلمة_المرور`', { parse_mode: 'Markdown' });
      return;
    }
    const [username, password] = parts;
    try {
      const shop = await prisma.shop.findUnique({ where: { username } });
      if (!shop) { bot.sendMessage(chatId, '❌ اسم المستخدم غير موجود.'); return; }
      const bcrypt = require('bcryptjs');
      const isValid = await bcrypt.compare(password, shop.password);
      if (!isValid) { bot.sendMessage(chatId, '❌ كلمة المرور غير صحيحة.'); return; }
      await prisma.shop.update({ where: { id: shop.id }, data: { ownerTelegramId: chatId } });
      logger.info(`[Telegram] Owner linked: chatId=${chatId} shop=${shop.id}`);
      bot.sendMessage(chatId,
        `🎉 *أهلاً بك في بوت الإدارة الخاص بمتجرك!*\n\n` +
        `✅ تم ربط حسابك بنجاح بمتجر: *${shop.name}*\n\n` +
        `يمكنك الآن البدء في بناء الكتالوج الخاص بك بسهولة. ` +
        `كل ما عليك فعله هو إرسال صورة للمنتج، وسأقوم بسؤالك عن تفاصيله (الاسم، السعر، الوصف).\n\n` +
        `📌 *الأوامر المتاحة لك:*\n` +
        `📋 /products — عرض قائمة منتجاتك الحالية\n` +
        `⚙️ /settings — التحكم في إعدادات التوصيل والدفع\n\n` +
        `أنا جاهز.. 📸 أرسل لي أول صورة متى ما أردت!`,
        { parse_mode: 'Markdown' }
      );
    } catch (e: any) {
      logger.error(`[Telegram] Link error: ${e.message}`);
      bot.sendMessage(chatId, '❌ حدث خطأ. يرجى المحاولة مجدداً.');
    }
  });

  // -------------------------------------------------------------------
  // /settings — عرض إعدادات الاستلام والدفع
  // -------------------------------------------------------------------
  bot.onText(/\/settings/, async (msg: any) => {
    const chatId = String(msg.chat.id);
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });
    if (!shop) { bot.sendMessage(chatId, '❌ أرسل /start للبدء.'); return; }
    const s = (v: boolean) => v ? '✅ مفعّل' : '❌ موقوف';
    bot.sendMessage(chatId,
      `⚙️ *إعدادات ${shop.name}*\n\n` +
      `🚚 *الاستلام:*\n` +
      `• التوصيل: ${s(shop.enableDelivery)}\n` +
      `• الاستلام من المحل: ${s(shop.enablePickup)}\n\n` +
      `💳 *الدفع:*\n` +
      `• الدفع الإلكتروني: ${s(shop.enableOnlinePayment)}\n` +
      `• الدفع نقداً: ${s(shop.enableCashPayment)}\n\n` +
      `للتغيير السريع:\n` +
      `\`/toggle delivery\` — تبديل التوصيل\n` +
      `\`/toggle pickup\` — تبديل الاستلام من المحل\n` +
      `\`/toggle online\` — تبديل الدفع الإلكتروني\n` +
      `\`/toggle cash\` — تبديل الدفع النقدي`,
      { parse_mode: 'Markdown' }
    );
  });

  // -------------------------------------------------------------------
  // /toggle — تبديل إعداد معين
  // -------------------------------------------------------------------
  bot.onText(/\/toggle (.+)/, async (msg: any, match: any) => {
    const chatId = String(msg.chat.id);
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });
    if (!shop) { bot.sendMessage(chatId, '❌ أرسل /start للبدء.'); return; }

    const opt = match[1].trim().toLowerCase();
    const map: Record<string, { field: string; label: string }> = {
      delivery: { field: 'enableDelivery',     label: 'التوصيل' },
      pickup:   { field: 'enablePickup',        label: 'الاستلام من المحل' },
      online:   { field: 'enableOnlinePayment', label: 'الدفع الإلكتروني' },
      cash:     { field: 'enableCashPayment',   label: 'الدفع النقدي' },
    };

    const t = map[opt];
    if (!t) {
      bot.sendMessage(chatId, '❌ خيار غير صحيح. جرب: delivery / pickup / online / cash');
      return;
    }

    const newVal = !(shop as any)[t.field];

    // حماية: لا يمكن إيقاف كلا خياري نفس النوع
    if (t.field === 'enableDelivery'     && !newVal && !shop.enablePickup)        { bot.sendMessage(chatId, '⚠️ لا يمكن إيقاف التوصيل والاستلام معاً.'); return; }
    if (t.field === 'enablePickup'        && !newVal && !shop.enableDelivery)      { bot.sendMessage(chatId, '⚠️ لا يمكن إيقاف الاستلام والتوصيل معاً.'); return; }
    if (t.field === 'enableOnlinePayment' && !newVal && !shop.enableCashPayment)   { bot.sendMessage(chatId, '⚠️ لا يمكن إيقاف الدفع الإلكتروني والنقدي معاً.'); return; }
    if (t.field === 'enableCashPayment'   && !newVal && !shop.enableOnlinePayment) { bot.sendMessage(chatId, '⚠️ لا يمكن إيقاف الدفع النقدي والإلكتروني معاً.'); return; }

    await prisma.shop.update({ where: { id: shop.id }, data: { [t.field]: newVal } });
    logger.info(`[Telegram] Toggled ${t.field}=${newVal} for shop ${shop.id}`);

    bot.sendMessage(chatId,
      `${newVal ? '✅' : '❌'} *${t.label}* أصبح ${newVal ? 'مفعّلاً' : 'موقوفاً'}\n\nأرسل /settings لعرض جميع الإعدادات.`,
      { parse_mode: 'Markdown' }
    );
  });

  // -------------------------------------------------------------------
  // /products — عرض قائمة المنتجات
  // -------------------------------------------------------------------
  bot.onText(/\/products/, async (msg: any) => {
    const chatId = String(msg.chat.id);
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });
    if (!shop) { bot.sendMessage(chatId, '❌ أرسل /start للبدء.'); return; }

    const products = await prisma.product.findMany({ where: { shopId: shop.id }, orderBy: { name: 'asc' } });
    if (!products.length) {
      bot.sendMessage(chatId, '📭 لا توجد منتجات بعد.\n\nأرسل صورة منتج لإضافته!');
      return;
    }

    const list = products.map((p, i) =>
      `${i + 1}. *${p.name}* — ${p.price} ريال ${p.available ? '✅' : '❌'}`
    ).join('\n');

    bot.sendMessage(chatId,
      `📋 *منتجات ${shop.name}* (${products.length})\n\n${list}`,
      { parse_mode: 'Markdown' }
    );
  });

  // -------------------------------------------------------------------
  // /cancel
  // -------------------------------------------------------------------
  bot.onText(/\/cancel/, (msg: any) => {
    const chatId = String(msg.chat.id);
    ownerSessions.delete(chatId);
    bot.sendMessage(chatId, '❌ تم الإلغاء. أرسل صورة منتج جديد في أي وقت.');
  });

  // -------------------------------------------------------------------
  // استقبال الصور
  // -------------------------------------------------------------------
  bot.on('photo', async (msg: any) => {
    const chatId = String(msg.chat.id);
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });
    if (!shop) { bot.sendMessage(chatId, '❌ أرسل /start أولاً.'); return; }

    try {
      const photos = msg.photo;
      const bestPhoto = photos[photos.length - 1];
      const fileInfo = await bot.getFile(bestPhoto.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

      const uploadsDir = path.join(__dirname, '../../public/uploads/products');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const ext = fileInfo.file_path?.split('.').pop() || 'jpg';
      const filename = `${shop.id}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const localPath = path.join(uploadsDir, filename);

      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      fs.writeFileSync(localPath, Buffer.from(response.data));

      const imageUrl = `/uploads/products/${filename}`;
      const caption = msg.caption?.trim();

      if (caption) {
        ownerSessions.set(chatId, { shopId: shop.id, shopName: shop.name, state: 'WAITING_PRICE', tempImageUrl: imageUrl, tempName: caption });
        bot.sendMessage(chatId,
          `✅ تم استلام الصورة!\n📝 الاسم: *${caption}*\n\n💰 كم سعر المنتج؟`,
          { parse_mode: 'Markdown' }
        );
      } else {
        ownerSessions.set(chatId, { shopId: shop.id, shopName: shop.name, state: 'WAITING_NAME', tempImageUrl: imageUrl });
        bot.sendMessage(chatId, '✅ تم استلام الصورة! 📸\n\nما اسم هذا المنتج؟');
      }
    } catch (e: any) {
      logger.error(`[Telegram] Photo error: ${e.message}`);
      bot.sendMessage(chatId, '❌ فشل تحميل الصورة. يرجى المحاولة مجدداً.');
    }
  });

  // -------------------------------------------------------------------
  // استقبال النصوص (دورة إضافة المنتج)
  // -------------------------------------------------------------------
  bot.on('text', async (msg: any) => {
    if (msg.text?.startsWith('/')) return;
    const chatId = String(msg.chat.id);
    const text = msg.text?.trim() || '';
    const session = ownerSessions.get(chatId);

    if (!session) {
      const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });
      if (shop) {
        bot.sendMessage(chatId, '📸 أرسل صورة منتج لإضافته\n⚙️ /settings — إعدادات المتجر\n📋 /products — قائمة المنتجات');
      } else {
        bot.sendMessage(chatId, 'أرسل /start للبدء.');
      }
      return;
    }

    switch (session.state) {
      case 'WAITING_NAME':
        session.tempName = text;
        session.state = 'WAITING_PRICE';
        bot.sendMessage(chatId, `✅ الاسم: *${text}*\n\n💰 كم سعر المنتج؟ (رقم فقط مثل: 50)`, { parse_mode: 'Markdown' });
        break;

      case 'WAITING_PRICE': {
        const price = parseFloat(text.replace(/[^\d.]/g, ''));
        if (isNaN(price) || price <= 0) { bot.sendMessage(chatId, '❌ يرجى إدخال سعر صحيح (مثال: 50)'); return; }
        session.tempPrice = price;
        session.state = 'WAITING_DESC';
        bot.sendMessage(chatId, `✅ السعر: *${price} ريال*\n\n📝 أضف وصفاً قصيراً\n(أو أرسل "تخطي")`, { parse_mode: 'Markdown' });
        break;
      }

      case 'WAITING_DESC': {
        session.tempDesc = text === 'تخطي' ? '' : text;
        session.state = 'WAITING_STOCK';
        bot.sendMessage(chatId, `✅ الوصف: ${session.tempDesc || 'لا يوجد'}\n\n📦 كم عدد الوحدات المتاحة في المخزون؟ (مثال: 10)`);
        break;
      }

      case 'WAITING_STOCK': {
        const stock = parseInt(text.replace(/[^\d]/g, ''));
        if (isNaN(stock) || stock < 0) { bot.sendMessage(chatId, '❌ يرجى إدخال عدد صحيح (مثال: 10)'); return; }
        try {
          const product = await prisma.product.create({
            data: {
              shopId: session.shopId,
              name: session.tempName!,
              price: session.tempPrice!,
              description: session.tempDesc || '',
              imageUrl: session.tempImageUrl!,
              category: 'عام',
              available: true,
              stock,
            },
          });
          ownerSessions.delete(chatId);
          logger.info(`[Telegram] Product created: ${product.name} for shop ${session.shopId}`);
          bot.sendMessage(chatId,
            `🎉 *تم إضافة المنتج بنجاح!*\n\n` +
            `📦 *${session.tempName}*\n` +
            `💰 ${session.tempPrice} ريال\n` +
            (session.tempDesc ? `📝 ${session.tempDesc}\n` : '') +
            `🔢 الكمية: ${stock}\n\n` +
            `أرسل صورة منتج آخر، أو /products لعرض الكتالوج.`,
            { parse_mode: 'Markdown' }
          );
        } catch (e: any) {
          logger.error(`[Telegram] Product save error: ${e.message}`);
          bot.sendMessage(chatId, '❌ فشل حفظ المنتج. يرجى المحاولة مجدداً.');
          ownerSessions.delete(chatId);
        }
        break;
      }
    }
  });

  bot.on('polling_error', (err: any) => {
    logger.error(`[Telegram] Polling error: ${err.message}`);
  });
}

export function getTelegramBot(): any {
  return bot;
}
