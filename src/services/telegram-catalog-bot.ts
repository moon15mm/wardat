import TelegramBot from 'node-telegram-bot-api';
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
  state: 'IDLE' | 'WAITING_NAME' | 'WAITING_PRICE' | 'WAITING_DESC';
  tempImageUrl?: string;
  tempName?: string;
  tempPrice?: number;
}

const ownerSessions = new Map<string, OwnerSession>();

let bot: TelegramBot | null = null;

export function initTelegramBot(token: string): void {
  if (bot) return;

  bot = new TelegramBot(token, { polling: true });
  logger.info('[Telegram] Bot started successfully ✅');

  // -------------------------------------------------------------------
  // /start — ربط الحساب بالمتجر
  // -------------------------------------------------------------------
  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    const firstName = msg.from?.first_name || 'مدير';

    // تحقق إذا كان مرتبطاً بمتجر
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });

    if (shop) {
      bot!.sendMessage(chatId,
        `مرحباً بك مجدداً يا ${firstName}! 👑\n\n` +
        `متجرك: *${shop.name}*\n\n` +
        `📸 أرسل صورة أي منتج لإضافته للكتالوج فوراً!\n` +
        `📋 أرسل /products لعرض منتجاتك\n` +
        `❌ أرسل /cancel لإلغاء أي عملية`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    bot!.sendMessage(chatId,
      `مرحباً ${firstName}! 👋\n\n` +
      `هذا البوت خاص بإدارة كتالوج متجرك.\n\n` +
      `لربط حسابك، أرسل:\n` +
      `\`/link اسم_المستخدم كلمة_المرور\`\n\n` +
      `مثال:\n` +
      `\`/link myshop 123456\``,
      { parse_mode: 'Markdown' }
    );
  });

  // -------------------------------------------------------------------
  // /link — ربط حساب التلجرام بالمتجر عبر بيانات الدخول
  // -------------------------------------------------------------------
  bot.onText(/\/link (.+)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const parts = match![1].trim().split(/\s+/);

    if (parts.length < 2) {
      bot!.sendMessage(chatId, '❌ صيغة خاطئة. أرسل:\n`/link اسم_المستخدم كلمة_المرور`', { parse_mode: 'Markdown' });
      return;
    }

    const [username, password] = parts;

    try {
      const shop = await prisma.shop.findUnique({ where: { username } });

      if (!shop) {
        bot!.sendMessage(chatId, '❌ اسم المستخدم غير موجود.');
        return;
      }

      // التحقق من كلمة المرور
      const bcrypt = require('bcryptjs');
      const isValid = await bcrypt.compare(password, shop.password);

      if (!isValid) {
        bot!.sendMessage(chatId, '❌ كلمة المرور غير صحيحة.');
        return;
      }

      // حفظ الـ Telegram Chat ID
      await prisma.shop.update({
        where: { id: shop.id },
        data: { ownerTelegramId: chatId },
      });

      logger.info(`[Telegram] Owner linked: chatId=${chatId} → shopId=${shop.id}`);

      bot!.sendMessage(chatId,
        `✅ *تم الربط بنجاح!*\n\n` +
        `متجرك: *${shop.name}*\n\n` +
        `الآن يمكنك:\n` +
        `📸 إرسال صورة المنتج لإضافته للكتالوج\n` +
        `📋 /products — عرض المنتجات\n` +
        `❌ /cancel — إلغاء العملية الحالية`,
        { parse_mode: 'Markdown' }
      );
    } catch (err: any) {
      logger.error(`[Telegram] Link error: ${err.message}`);
      bot!.sendMessage(chatId, '❌ حدث خطأ. يرجى المحاولة مجدداً.');
    }
  });

  // -------------------------------------------------------------------
  // /products — عرض قائمة المنتجات
  // -------------------------------------------------------------------
  bot.onText(/\/products/, async (msg) => {
    const chatId = String(msg.chat.id);
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });

    if (!shop) {
      bot!.sendMessage(chatId, '❌ لم يتم ربط حسابك بعد. أرسل /start للبدء.');
      return;
    }

    const products = await prisma.product.findMany({
      where: { shopId: shop.id },
      orderBy: { name: 'asc' },
    });

    if (!products.length) {
      bot!.sendMessage(chatId, '📭 لا توجد منتجات في الكتالوج بعد.\n\nأرسل صورة منتج لإضافته!');
      return;
    }

    const list = products.map((p, i) =>
      `${i + 1}. *${p.name}* — ${p.price} ريال ${p.available ? '✅' : '❌'}`
    ).join('\n');

    bot!.sendMessage(chatId,
      `📋 *منتجات ${shop.name}* (${products.length})\n\n${list}`,
      { parse_mode: 'Markdown' }
    );
  });

  // -------------------------------------------------------------------
  // /cancel — إلغاء العملية الحالية
  // -------------------------------------------------------------------
  bot.onText(/\/cancel/, (msg) => {
    const chatId = String(msg.chat.id);
    ownerSessions.delete(chatId);
    bot!.sendMessage(chatId, '❌ تم الإلغاء. أرسل صورة منتج جديد في أي وقت.');
  });

  // -------------------------------------------------------------------
  // استقبال الصور
  // -------------------------------------------------------------------
  bot.on('photo', async (msg) => {
    const chatId = String(msg.chat.id);
    const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });

    if (!shop) {
      bot!.sendMessage(chatId, '❌ لم يتم ربط حسابك. أرسل /start أولاً.');
      return;
    }

    try {
      // أكبر جودة متاحة
      const photos = msg.photo!;
      const bestPhoto = photos[photos.length - 1];
      const fileInfo = await bot!.getFile(bestPhoto.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

      // تحميل وحفظ الصورة
      const uploadsDir = path.join(__dirname, '../../public/uploads/products');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

      const ext = fileInfo.file_path?.split('.').pop() || 'jpg';
      const filename = `${shop.id}_${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const localPath = path.join(uploadsDir, filename);

      const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
      fs.writeFileSync(localPath, Buffer.from(response.data));

      const imageUrl = `/uploads/products/${filename}`;

      // حفظ الجلسة مع رابط الصورة
      ownerSessions.set(chatId, {
        shopId: shop.id,
        shopName: shop.name,
        state: 'WAITING_NAME',
        tempImageUrl: imageUrl,
      });

      // إذا كان فيه caption مع الصورة استخدمه كاسم مؤقت
      const caption = msg.caption?.trim();
      if (caption) {
        ownerSessions.get(chatId)!.tempName = caption;
        ownerSessions.get(chatId)!.state = 'WAITING_PRICE';
        bot!.sendMessage(chatId,
          `✅ تم استلام الصورة!\n` +
          `📝 الاسم: *${caption}*\n\n` +
          `💰 كم سعر المنتج؟ (أرسل رقماً مثل: 50)`,
          { parse_mode: 'Markdown' }
        );
      } else {
        bot!.sendMessage(chatId,
          `✅ تم استلام الصورة! 📸\n\n` +
          `ما اسم هذا المنتج؟`,
        );
      }
    } catch (err: any) {
      logger.error(`[Telegram] Photo handling error: ${err.message}`);
      bot!.sendMessage(chatId, '❌ فشل تحميل الصورة. يرجى المحاولة مجدداً.');
    }
  });

  // -------------------------------------------------------------------
  // استقبال النصوص (دورة إضافة المنتج)
  // -------------------------------------------------------------------
  bot.on('text', async (msg) => {
    if (msg.text?.startsWith('/')) return; // الأوامر تُعالج بالأعلى

    const chatId = String(msg.chat.id);
    const text = msg.text?.trim() || '';
    const session = ownerSessions.get(chatId);

    if (!session) {
      // لا توجد جلسة نشطة
      const shop = await prisma.shop.findFirst({ where: { ownerTelegramId: chatId } });
      if (shop) {
        bot!.sendMessage(chatId,
          `📸 أرسل صورة المنتج لإضافته للكتالوج\n` +
          `📋 أو أرسل /products لعرض منتجاتك`
        );
      } else {
        bot!.sendMessage(chatId, 'أرسل /start للبدء.');
      }
      return;
    }

    switch (session.state) {
      case 'WAITING_NAME':
        session.tempName = text;
        session.state = 'WAITING_PRICE';
        bot!.sendMessage(chatId,
          `✅ الاسم: *${text}*\n\n💰 كم سعر المنتج؟ (رقم فقط مثل: 50)`,
          { parse_mode: 'Markdown' }
        );
        break;

      case 'WAITING_PRICE': {
        const price = parseFloat(text.replace(/[^\d.]/g, ''));
        if (isNaN(price) || price <= 0) {
          bot!.sendMessage(chatId, '❌ يرجى إدخال سعر صحيح (مثال: 50 أو 29.99)');
          return;
        }
        session.tempPrice = price;
        session.state = 'WAITING_DESC';
        bot!.sendMessage(chatId,
          `✅ السعر: *${price} ريال*\n\n` +
          `📝 أضف وصفاً قصيراً للمنتج\n` +
          `(أو أرسل "تخطي" إذا لم تريد وصفاً)`,
          { parse_mode: 'Markdown' }
        );
        break;
      }

      case 'WAITING_DESC': {
        const desc = text === 'تخطي' ? '' : text;

        try {
          const product = await prisma.product.create({
            data: {
              shopId: session.shopId,
              name: session.tempName!,
              price: session.tempPrice!,
              description: desc,
              imageUrl: session.tempImageUrl!,
              category: 'عام',
              available: true,
              stock: 10,
            },
          });

          ownerSessions.delete(chatId);

          logger.info(`[Telegram] Product created: ${product.name} for shop ${session.shopId}`);

          bot!.sendMessage(chatId,
            `🎉 *تم إضافة المنتج بنجاح!*\n\n` +
            `📦 *${session.tempName}*\n` +
            `💰 ${session.tempPrice} ريال\n` +
            (desc ? `📝 ${desc}\n` : '') +
            `\nأرسل صورة منتج آخر لإضافته، أو /products لعرض الكتالوج.`,
            { parse_mode: 'Markdown' }
          );
        } catch (err: any) {
          logger.error(`[Telegram] Product save error: ${err.message}`);
          bot!.sendMessage(chatId, '❌ فشل حفظ المنتج. يرجى المحاولة مجدداً.');
          ownerSessions.delete(chatId);
        }
        break;
      }
    }
  });

  bot.on('polling_error', (err) => {
    logger.error(`[Telegram] Polling error: ${err.message}`);
  });
}

export function getTelegramBot(): TelegramBot | null {
  return bot;
}
