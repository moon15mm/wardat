import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../services/db';
import { hashPassword, verifyPassword, generateToken } from '../utils/auth';
import { authenticateSuperAdmin, authenticateShop } from '../middlewares/auth';
import { sendPasswordResetEmail } from '../services/email';
import * as settings from '../services/settings';
import { generateOutreachDrafts, DraftKind } from '../services/outreach';
import * as backup from '../services/backup';
import logger from '../utils/logger';
import { getAgentSettings, saveAgentSettings, runAcquisitionCycle } from '../services/agent-acquisition';
import { getAgentLogs, clearAgentLogs, logAgentAction } from '../utils/agent-logger';
import { discoverFlowerShops } from '../services/lead-finder';
import { sendTextMessage, WhatsAppConfig } from '../services/whatsapp';
import { getSessionStatus } from '../services/baileys-manager';
import { maskPhone } from '../utils/helpers';

const router = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && EMAIL_REGEX.test(value.trim());
}

// Hash a reset token before storing it, so a DB leak can't be used to reset passwords.
function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Configurable free-trial length in days (default 14).
function trialDays(): number {
  const n = parseInt(settings.raw('TRIAL_DAYS') || '14', 10);
  return isNaN(n) ? 14 : Math.min(90, Math.max(1, n));
}

// Compute a subscription end date: TRIAL is measured in days, paid plans in months.
function computeSubscriptionEnd(plan: string, months: number, base: Date = new Date()): Date {
  if (plan === 'TRIAL') {
    return new Date(base.getTime() + trialDays() * 24 * 60 * 60 * 1000);
  }
  return new Date(base.getTime() + months * 30 * 24 * 60 * 60 * 1000);
}

// Constant-time string comparison to avoid timing attacks on admin credentials.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Mask a secret for display: keep last 4 chars, replace the rest with dots.
function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '••••';
  return '••••' + value.slice(-4);
}

// -------------------------------------------------------------
// 1. PUBLIC AUTH ROUTE
// -------------------------------------------------------------
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'يرجى تقديم اسم المستخدم وكلمة المرور' });
  }

  // Check if it matches Super Admin
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || '';

  if (adminPass && safeEqual(username, adminUser) && safeEqual(password, adminPass)) {
    const token = generateToken({ role: 'superadmin' });
    return res.json({ token, role: 'superadmin', name: 'مدير النظام' });
  }

  // Check if it matches a Shop in database
  try {
    const shop = await prisma.shop.findUnique({
      where: { username },
    });

    if (shop) {
      const { valid, needsRehash } = await verifyPassword(password, shop.password);
      if (valid) {
        // Transparently upgrade legacy SHA-256 hashes to bcrypt on successful login.
        if (needsRehash) {
          try {
            await prisma.shop.update({
              where: { id: shop.id },
              data: { password: await hashPassword(password) },
            });
          } catch (e) {
            logger.warn(`[Auth] Failed to rehash password for shop ${shop.id}`);
          }
        }
        const token = generateToken({ role: 'shop', shopId: shop.id });
        return res.json({ token, role: 'shop', shopId: shop.id, name: shop.name });
      }
    }
  } catch (err: any) {
    logger.error(`[Auth] Login DB error: ${err.message}`);
    return res.status(500).json({ error: 'حدث خطأ في الاتصال بقاعدة البيانات' });
  }

  return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

// -------------------------------------------------------------
// PASSWORD RESET (shop owners)
// -------------------------------------------------------------

// Request a reset link by email. Always responds success to avoid leaking which
// emails are registered.
router.post('/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const genericMsg = 'إذا كان البريد مسجلاً لدينا، فستصلك رسالة بخطوات إعادة تعيين كلمة المرور.';

  if (!isValidEmail(email)) {
    // Don't reveal validity; still respond the same way.
    return res.json({ message: genericMsg });
  }

  try {
    const normalizedEmail = email.trim().toLowerCase();
    const shop = await prisma.shop.findUnique({ where: { email: normalizedEmail } });

    if (shop) {
      // Generate a one-time token; store only its hash with a 60-minute expiry.
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashResetToken(rawToken);
      const expiry = new Date(Date.now() + 60 * 60 * 1000);

      await prisma.shop.update({
        where: { id: shop.id },
        data: { resetToken: tokenHash, resetTokenExpiry: expiry },
      });

      // SECURITY: never build the reset link from the request Host header — a forged
      // Host would let an attacker poison the link and steal the reset token. Always
      // use the server-configured base URL (defaults to https://wardat.xyz).
      const baseUrl = settings.getAppBaseUrl();
      const resetLink = `${baseUrl}/reset-password?token=${rawToken}`;

      try {
        await sendPasswordResetEmail(normalizedEmail, shop.name, resetLink);
      } catch (mailErr: any) {
        logger.error(`[Auth] Failed to send reset email to ${normalizedEmail}: ${mailErr.message}`);
        // Still respond generically; the token is stored and link was logged in dev.
      }
    } else {
      logger.info(`[Auth] Password reset requested for unregistered email: ${normalizedEmail}`);
    }

    return res.json({ message: genericMsg });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.json({ message: genericMsg });
  }
});

// Complete the reset with a valid token + new password.
router.post('/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'رابط إعادة التعيين غير صالح.' });
  }
  if (!password || typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'يجب أن تتكون كلمة المرور من 6 أحرف على الأقل.' });
  }

  try {
    const tokenHash = hashResetToken(token);
    const shop = await prisma.shop.findFirst({
      where: {
        resetToken: tokenHash,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!shop) {
      return res.status(400).json({ error: 'رابط إعادة التعيين غير صالح أو منتهي الصلاحية. يرجى طلب رابط جديد.' });
    }

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        password: await hashPassword(password),
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    logger.info(`[Auth] Password reset completed for shop ${shop.id}`);
    return res.json({ message: 'تم تغيير كلمة المرور بنجاح. يمكنك الآن تسجيل الدخول.' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    return res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// Public: current plan prices + discount tiers (used by the dashboard pricing UI).
router.get('/plans', (req, res) => {
  res.json({
    prices: {
      SILVER: settings.getPlanPrice('SILVER'),
      GOLD: settings.getPlanPrice('GOLD'),
      PLATINUM: settings.getPlanPrice('PLATINUM'),
    },
    discountPercents: {
      3: Math.round(settings.getDiscountFraction(3) * 100),
      6: Math.round(settings.getDiscountFraction(6) * 100),
      12: Math.round(settings.getDiscountFraction(12) * 100),
    },
  });
});

router.get('/whatsapp/test-connection', async (req, res) => {
  const dns = require('dns');
  const net = require('net');
  const results: any = {};

  const targets = [
    { host: 'web.whatsapp.com', port: 443 },
    { host: 'g.us', port: 443 },
    { host: 'g.us', port: 5222 },
  ];

  try {
    for (const target of targets) {
      results[target.host + ':' + target.port] = await new Promise((resolve) => {
        dns.lookup(target.host, { family: 4 }, (dnsErr: any, address: string) => {
          if (dnsErr) {
            resolve({ status: 'dns_failed', error: dnsErr.message });
            return;
          }

          const socket = new net.Socket();
          socket.setTimeout(4000);

          socket.on('connect', () => {
            socket.destroy();
            resolve({ status: 'connected', ip: address });
          });

          socket.on('error', (err: any) => {
            socket.destroy();
            resolve({ status: 'failed', ip: address, error: err.message });
          });

          socket.on('timeout', () => {
            socket.destroy();
            resolve({ status: 'timeout', ip: address });
          });

          socket.connect(target.port, address);
        });
      });
    }
    res.json(results);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// -------------------------------------------------------------
// 2. SUPER ADMIN ROUTES (Protected)
// -------------------------------------------------------------
router.get('/admin/stats', authenticateSuperAdmin, async (req, res) => {
  try {
    const shopsCount = await prisma.shop.count();
    const ordersCount = await prisma.order.count();
    const sessionsCount = await prisma.session.count();

    const revenueAggregate = await prisma.order.aggregate({
      where: { paymentStatus: 'CONFIRMED' },
      _sum: { price: true },
    });

    res.json({
      activeShops: shopsCount,
      totalOrders: ordersCount,
      totalSessions: sessionsCount,
      totalRevenue: revenueAggregate._sum.price || 0,
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.get('/admin/shops', authenticateSuperAdmin, async (req, res) => {
  try {
    const shops = await prisma.shop.findMany({
      include: {
        _count: {
          select: { products: true, orders: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(
      shops.map((s) => ({
        id: s.id,
        name: s.name,
        subdomain: s.subdomain,
        username: s.username,
        email: s.email,
        whatsappType: s.whatsappType,
        whatsappPhoneId: s.whatsappPhoneId,
        aiProvider: s.aiProvider,
        geminiApiKey: maskSecret(s.geminiApiKey),
        openaiApiKey: maskSecret(s.openaiApiKey),
        ultramsgInstanceId: s.ultramsgInstanceId,
        ultramsgToken: maskSecret(s.ultramsgToken),
        createdAt: s.createdAt,
        productsCount: s._count.products,
        ordersCount: s._count.orders,
        subscriptionPlan: s.subscriptionPlan,
        subscriptionEnd: s.subscriptionEnd,
        subscriptionStatus: s.subscriptionStatus,
      }))
    );
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.post('/admin/shops', authenticateSuperAdmin, async (req, res) => {
  const {
    name,
    subdomain,
    username,
    email,
    password,
    whatsappType,
    whatsappPhoneId,
    whatsappToken,
    whatsappVerifyToken,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeSuccessUrl,
    stripeCancelUrl,
    whatsappAdminGroupId,
    aiProvider,
    geminiApiKey,
    openaiApiKey,
    logoUrl,
    ownerPhone,
    ultramsgInstanceId,
    ultramsgToken,
    subscriptionPlan,
    subscriptionDurationMonths,
  } = req.body;

  if (!name || !subdomain || !username || !password) {
    return res.status(400).json({ error: 'يرجى تقديم اسم المتجر، الدومين الفرعي، اسم المستخدم وكلمة المرور' });
  }

  // Email is required so the shop owner can recover a forgotten password.
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'يرجى تقديم بريد إلكتروني صالح للمتجر (مطلوب لاستعادة كلمة المرور)' });
  }
  const normalizedEmail = (email as string).trim().toLowerCase();

  try {
    const existingShop = await prisma.shop.findFirst({
      where: {
        OR: [{ subdomain }, { username }, { email: normalizedEmail }],
      },
    });

    if (existingShop) {
      return res.status(400).json({
        error: 'اسم المستخدم أو الدومين الفرعي أو البريد الإلكتروني مسجل مسبقاً لمتجر آخر',
      });
    }

    if (whatsappPhoneId) {
      const existingPhone = await prisma.shop.findFirst({
        where: { whatsappPhoneId },
      });
      if (existingPhone) {
        return res.status(400).json({
          error: 'رقم الواتساب مسجل مسبقاً لمتجر آخر',
        });
      }
    }

    const months = subscriptionDurationMonths ? parseInt(subscriptionDurationMonths) : 1;
    const subscriptionEnd = computeSubscriptionEnd(subscriptionPlan, months);

    const shop = await prisma.shop.create({
      data: {
        name,
        subdomain,
        username,
        email: normalizedEmail,
        password: await hashPassword(password),
        whatsappType: whatsappType || 'BUSINESS',
        whatsappPhoneId: whatsappPhoneId || null,
        whatsappToken: whatsappToken || null,
        whatsappVerifyToken: whatsappVerifyToken || null,
        stripeSecretKey: stripeSecretKey || null,
        stripeWebhookSecret: stripeWebhookSecret || null,
        stripeSuccessUrl: stripeSuccessUrl || null,
        stripeCancelUrl: stripeCancelUrl || null,
        whatsappAdminGroupId: whatsappAdminGroupId || null,
        aiProvider: aiProvider || 'OPENAI',
        geminiApiKey: geminiApiKey || null,
        openaiApiKey: openaiApiKey || null,
        logoUrl: logoUrl || null,
        ownerPhone: ownerPhone || null,
        ultramsgInstanceId: ultramsgInstanceId || null,
        ultramsgToken: ultramsgToken || null,
        subscriptionPlan: subscriptionPlan || 'SILVER',
        subscriptionStatus: 'ACTIVE',
        subscriptionEnd: subscriptionEnd,
      },
    });

    const { password: _pw, ...safeShop } = shop;
    res.status(201).json(safeShop);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.delete('/admin/shops/:id', authenticateSuperAdmin, async (req, res) => {
  try {
    await prisma.shop.delete({
      where: { id: req.params.id as string },
    });
    res.json({ message: 'تم حذف المتجر وبياناته بنجاح' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.put('/admin/shops/:id', authenticateSuperAdmin, async (req, res) => {
  const { subscriptionPlan, subscriptionDurationMonths, subscriptionStatus, openaiApiKey } = req.body;

  try {
    const shop = await prisma.shop.findUnique({
      where: { id: req.params.id as string },
    });

    if (!shop) {
      return res.status(404).json({ error: 'المتجر غير موجود' });
    }

    const updateData: any = {};
    if (subscriptionPlan) updateData.subscriptionPlan = subscriptionPlan;
    if (subscriptionStatus) updateData.subscriptionStatus = subscriptionStatus;
    if (openaiApiKey !== undefined) {
      updateData.openaiApiKey = openaiApiKey.trim() || null;
    }

    if (subscriptionPlan === 'TRIAL') {
      // Trial always starts fresh from now for the configured number of days.
      updateData.subscriptionEnd = computeSubscriptionEnd('TRIAL', 0);
      updateData.subscriptionStatus = 'ACTIVE';
    } else if (subscriptionDurationMonths) {
      const months = parseInt(subscriptionDurationMonths);
      const baseDate = shop.subscriptionEnd && new Date(shop.subscriptionEnd) > new Date()
        ? new Date(shop.subscriptionEnd)
        : new Date();

      updateData.subscriptionEnd = new Date(baseDate.getTime() + months * 30 * 24 * 60 * 60 * 1000);
      updateData.subscriptionStatus = 'ACTIVE';
    }

    const updated = await prisma.shop.update({
      where: { id: req.params.id as string },
      data: updateData,
    });

    const { password: _pw, ...safeUpdated } = updated;
    res.json({ message: 'تم تحديث خطة اشتراك المتجر بنجاح', shop: safeUpdated });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// -------------------------------------------------------------
// PLATFORM SETTINGS (Super Admin) — plan prices + operational .env config
// -------------------------------------------------------------
router.get('/admin/settings', authenticateSuperAdmin, async (req, res) => {
  try {
    const all = settings.effectiveAll();
    const out: Record<string, string> = {};
    for (const key of Object.keys(all)) {
      out[key] = settings.SECRET_KEYS.has(key) ? (maskSecret(all[key]) || '') : all[key];
    }
    res.json(out);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.put('/admin/settings', authenticateSuperAdmin, async (req, res) => {
  const body = req.body || {};
  const updates: Record<string, string> = {};

  const priceKeys = ['PLAN_PRICE_SILVER', 'PLAN_PRICE_GOLD', 'PLAN_PRICE_PLATINUM'];
  const discountKeys = ['PLAN_DISCOUNT_3', 'PLAN_DISCOUNT_6', 'PLAN_DISCOUNT_12'];

  for (const key of settings.SETTING_KEYS) {
    if (!(key in body)) continue;
    const val = body[key];

    if (priceKeys.includes(key)) {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0) {
        return res.status(400).json({ error: `قيمة السعر غير صالحة: ${key}` });
      }
      updates[key] = String(Math.round(n));
    } else if (discountKeys.includes(key)) {
      const n = parseFloat(val);
      if (isNaN(n) || n < 0 || n > 90) {
        return res.status(400).json({ error: `نسبة الخصم يجب أن تكون بين 0 و 90: ${key}` });
      }
      updates[key] = String(Math.round(n));
    } else if (settings.SECRET_KEYS.has(key)) {
      // Don't overwrite a secret with a masked placeholder or an empty value.
      const str = typeof val === 'string' ? val : '';
      if (str.startsWith('••••') || str.trim() === '') continue;
      updates[key] = str.trim();
    } else {
      // Plain config (urls, host, port, user, from, secure flag) — store as-is.
      updates[key] = typeof val === 'string' ? val.trim() : String(val);
    }
  }

  try {
    const count = await settings.saveSettings(updates);
    res.json({ message: 'تم حفظ إعدادات النظام بنجاح', saved: count });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// -------------------------------------------------------------
// OUTREACH AGENT — prospect pipeline / CRM (Super Admin)
// Goal: land the first official subscriber. Drafts messages with AI;
// never sends automatically (operator copies & sends manually).
// -------------------------------------------------------------
const PROSPECT_STATUSES = ['NEW', 'CONTACTED', 'INTERESTED', 'DEMO', 'WON', 'LOST'];
const FOLLOWUP_ACTIVE = ['CONTACTED', 'INTERESTED', 'DEMO'];

// A prospect "needs follow-up" if it was contacted but has gone quiet for
// FOLLOWUP_DAYS. WON/LOST/NEW are never "due".
function computeDue(p: { status: string; lastContact: Date | null; updatedAt: Date }, days: number) {
  if (!FOLLOWUP_ACTIVE.includes(p.status)) return { due: false, staleDays: 0 };
  const base = p.lastContact ? new Date(p.lastContact).getTime() : new Date(p.updatedAt).getTime();
  const staleDays = Math.floor((Date.now() - base) / 86400000);
  return { due: staleDays >= days, staleDays };
}

router.get('/admin/prospects', authenticateSuperAdmin, async (req, res) => {
  try {
    const days = settings.getFollowupDays();
    const dueOnly = req.query.due === '1';
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const where = !dueOnly && status && PROSPECT_STATUSES.includes(status) ? { status } : {};
    const prospects = await prisma.prospect.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
    let mapped = prospects.map((p) => ({ ...p, ...computeDue(p, days) }));
    if (dueOnly) mapped = mapped.filter((x) => x.due);
    res.json(mapped);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.get('/admin/prospects/stats', authenticateSuperAdmin, async (req, res) => {
  try {
    const days = settings.getFollowupDays();
    const grouped = await prisma.prospect.groupBy({
      by: ['status'],
      _count: { status: true },
    });
    const counts: Record<string, number> = {};
    for (const s of PROSPECT_STATUSES) counts[s] = 0;
    let total = 0;
    for (const g of grouped) {
      counts[g.status] = g._count.status;
      total += g._count.status;
    }
    const active = await prisma.prospect.findMany({ where: { status: { in: FOLLOWUP_ACTIVE } } });
    const dueFollowups = active.filter((p) => computeDue(p, days).due).length;
    res.json({ total, counts, dueFollowups, followupDays: days });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.post('/admin/prospects', authenticateSuperAdmin, async (req, res) => {
  const { name, city, phone, instagram, source, status, notes } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'يرجى إدخال اسم المتجر المستهدف' });
  }
  try {
    const prospect = await prisma.prospect.create({
      data: {
        name: String(name).trim(),
        city: city || null,
        phone: phone || null,
        instagram: instagram || null,
        source: source || null,
        status: PROSPECT_STATUSES.includes(status) ? status : 'NEW',
        notes: notes || '',
      },
    });
    res.status(201).json(prospect);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.put('/admin/prospects/:id', authenticateSuperAdmin, async (req, res) => {
  const { name, city, phone, instagram, source, status, notes, touch } = req.body;
  try {
    const data: any = {};
    if (name !== undefined) data.name = String(name).trim();
    if (city !== undefined) data.city = city || null;
    if (phone !== undefined) data.phone = phone || null;
    if (instagram !== undefined) data.instagram = instagram || null;
    if (source !== undefined) data.source = source || null;
    if (notes !== undefined) data.notes = notes || '';
    if (status !== undefined) {
      if (!PROSPECT_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'حالة غير صالحة' });
      }
      data.status = status;
    }
    // "touch" records that we just reached out (sets lastContact to now).
    if (touch) data.lastContact = new Date();

    const updated = await prisma.prospect.update({
      where: { id: req.params.id as string },
      data,
    });
    res.json(updated);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.delete('/admin/prospects/:id', authenticateSuperAdmin, async (req, res) => {
  try {
    await prisma.prospect.delete({ where: { id: req.params.id as string } });
    res.json({ message: 'تم حذف العميل المحتمل' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// Generate AI outreach message drafts for a prospect (does NOT send).
router.post('/admin/prospects/:id/draft', authenticateSuperAdmin, async (req, res) => {
  const kind = (req.body?.kind || 'first_touch') as DraftKind;
  try {
    const prospect = await prisma.prospect.findUnique({ where: { id: req.params.id as string } });
    if (!prospect) return res.status(404).json({ error: 'العميل المحتمل غير موجود' });

    const variants = await generateOutreachDrafts(
      { name: prospect.name, city: prospect.city, source: prospect.source, notes: prospect.notes },
      kind
    );
    res.json({ variants });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'تعذّر توليد الرسالة حالياً. يرجى المحاولة لاحقاً.' });
  }
});

// -------------------------------------------------------------
// ACQUISITION AGENT SETTINGS & ACTIONS (Super Admin)
// -------------------------------------------------------------
router.get('/admin/agent/settings', authenticateSuperAdmin, async (req, res) => {
  try {
    const settingsData = await getAgentSettings();
    const shops = await prisma.shop.findMany({
      select: { id: true, name: true, subdomain: true, whatsappType: true }
    });
    res.json({ settings: settingsData, shops });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في جلب إعدادات الوكيل' });
  }
});

router.put('/admin/agent/settings', authenticateSuperAdmin, async (req, res) => {
  try {
    await saveAgentSettings(req.body);
    res.json({ message: 'تم حفظ إعدادات الوكيل بنجاح' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في حفظ إعدادات الوكيل' });
  }
});

router.post('/admin/agent/run', authenticateSuperAdmin, async (req, res) => {
  try {
    logAgentAction('[تشغيل يدوي] بدء تشغيل دورة الاستحواذ بطلب من المدير.');
    // Run async so it returns immediately
    runAcquisitionCycle();
    res.json({ message: 'تم تشغيل دورة الوكيل بنجاح في الخلفية' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في تشغيل الوكيل' });
  }
});

router.get('/admin/agent/logs', authenticateSuperAdmin, async (req, res) => {
  try {
    const logs = getAgentLogs(100);
    res.json({ logs });
  } catch (err: any) {
    res.status(500).json({ error: 'حدث خطأ في جلب السجلات' });
  }
});

router.post('/admin/agent/clear-logs', authenticateSuperAdmin, async (req, res) => {
  try {
    clearAgentLogs();
    logAgentAction('تم مسح السجلات بطلب من المدير.');
    res.json({ message: 'تم مسح السجلات بنجاح' });
  } catch (err: any) {
    res.status(500).json({ error: 'حدث خطأ في مسح السجلات' });
  }
});

router.post('/admin/agent/discover-leads', authenticateSuperAdmin, async (req, res) => {
  const { city } = req.body;
  if (!city) return res.status(400).json({ error: 'يرجى تحديد المدينة' });
  try {
    const leads = await discoverFlowerShops(city);
    res.json(leads);
  } catch (err: any) {
    res.status(500).json({ error: 'حدث خطأ أثناء اكتشاف المتاجر' });
  }
});

router.post('/admin/agent/send-message', authenticateSuperAdmin, async (req, res) => {
  const { prospectId, senderShopId, message } = req.body;
  if (!prospectId || !senderShopId || !message) {
    return res.status(400).json({ error: 'بيانات غير مكتملة' });
  }

  try {
    const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });
    if (!prospect || !prospect.phone) {
      return res.status(404).json({ error: 'العميل المحتمل غير موجود أو لا يملك رقم هاتف' });
    }

    const shop = await prisma.shop.findUnique({ where: { id: senderShopId } });
    if (!shop) {
      return res.status(404).json({ error: 'متجر الإرسال غير موجود' });
    }

    let active = false;
    if (shop.whatsappType === 'NORMAL') {
      const status = getSessionStatus(shop.id);
      active = status.status === 'CONNECTED';
    } else {
      active = !!(shop.whatsappToken && shop.whatsappPhoneId);
    }

    if (!active) {
      return res.status(400).json({ error: 'جلسة واتساب لمتجر الإرسال غير متصلة حالياً' });
    }

    const whatsappConfig: WhatsAppConfig = {
      whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
      shopId: shop.id,
      token: shop.whatsappToken,
      phoneId: shop.whatsappPhoneId,
      adminGroupId: shop.whatsappAdminGroupId,
      ultramsgInstanceId: shop.ultramsgInstanceId,
      ultramsgToken: shop.ultramsgToken,
    };

    await sendTextMessage(whatsappConfig, prospect.phone, message);
    
    // Update lastContact
    await prisma.prospect.update({
      where: { id: prospectId },
      data: {
        lastContact: new Date(),
        status: prospect.status === 'NEW' ? 'CONTACTED' : prospect.status,
        notes: `${prospect.notes}\n[واتساب البوت] تم إرسال رسالة مباشرة من البوت.`
      }
    });

    logAgentAction(`تم إرسال رسالة مباشرة إلى "${prospect.name}" عبر البوت.`);
    res.json({ message: 'تم إرسال الرسالة بنجاح وتحديث حالة العميل' });
  } catch (err: any) {
    logger.error(`[API] Send message error: ${err.message}`);
    res.status(500).json({ error: `فشل الإرسال: ${err.message}` });
  }
});


// -------------------------------------------------------------
// BACKUPS (Super Admin) — scheduled DB + sessions backups, manage & download
// -------------------------------------------------------------
router.get('/admin/backups', authenticateSuperAdmin, (req, res) => {
  try {
    res.json({
      backups: backup.listBackups(),
      enabled: settings.raw('BACKUP_ENABLED') !== 'false',
      retentionDays: parseInt(settings.raw('BACKUP_RETENTION_DAYS') || '14', 10),
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في جلب النسخ الاحتياطية.' });
  }
});

router.post('/admin/backups/run', authenticateSuperAdmin, async (req, res) => {
  try {
    const result = await backup.createBackup();
    const days = parseInt(settings.raw('BACKUP_RETENTION_DAYS') || '14', 10);
    await backup.applyRetention(days);
    res.json({ message: 'تم إنشاء نسخة احتياطية بنجاح', ...result });
  } catch (err: any) {
    logger.error(`[API] backup run failed: ${err.message}`);
    res.status(500).json({ error: `فشل إنشاء النسخة الاحتياطية: ${err.message}` });
  }
});

router.get('/admin/backups/download/:name', authenticateSuperAdmin, (req, res) => {
  const p = backup.safeBackupPath(req.params.name as string);
  if (!p) return res.status(404).json({ error: 'الملف غير موجود' });
  res.download(p, req.params.name as string);
});

router.delete('/admin/backups/:name', authenticateSuperAdmin, (req, res) => {
  const ok = backup.deleteBackup(req.params.name as string);
  if (!ok) return res.status(404).json({ error: 'الملف غير موجود' });
  res.json({ message: 'تم حذف النسخة الاحتياطية' });
});

router.put('/admin/backups/settings', authenticateSuperAdmin, async (req, res) => {
  try {
    const { enabled, retentionDays } = req.body || {};
    const updates: Record<string, string> = {};
    if (enabled !== undefined) updates.BACKUP_ENABLED = enabled ? 'true' : 'false';
    if (retentionDays !== undefined) {
      const n = parseInt(retentionDays, 10);
      if (isNaN(n) || n < 1 || n > 365) {
        return res.status(400).json({ error: 'مدة الاحتفاظ يجب أن تكون بين 1 و 365 يوماً' });
      }
      updates.BACKUP_RETENTION_DAYS = String(n);
    }
    await settings.saveSettings(updates);
    res.json({ message: 'تم حفظ إعدادات النسخ الاحتياطي' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم.' });
  }
});

// -------------------------------------------------------------
// 3. SHOP OWNER ROUTES (Protected)
// -------------------------------------------------------------
router.get('/shop/stats', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const productsCount = await prisma.product.count({ where: { shopId } });
    const ordersCount = await prisma.order.count({ where: { shopId } });
    const revenueAggregate = await prisma.order.aggregate({
      where: { shopId, paymentStatus: 'CONFIRMED' },
      _sum: { price: true },
    });

    res.json({
      totalProducts: productsCount,
      totalOrders: ordersCount,
      totalRevenue: revenueAggregate._sum.price || 0,
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.get('/shop/details', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
    });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    // Do not return hashed password or raw secrets. Mask sensitive fields so the
    // dashboard can show "configured / not configured" without exposing live keys.
    const { password, resetToken, resetTokenExpiry, ...rest } = shop;
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const monthlyOrdersCount = await prisma.order.count({
      where: { shopId, timestamp: { gte: startOfMonth } }
    });

    const details = {
      ...rest,
      whatsappToken: maskSecret(shop.whatsappToken),
      whatsappVerifyToken: maskSecret(shop.whatsappVerifyToken),
      stripeSecretKey: maskSecret(shop.stripeSecretKey),
      stripeWebhookSecret: maskSecret(shop.stripeWebhookSecret),
      moyasarApiKey: maskSecret(shop.moyasarApiKey),
      tapApiKey: maskSecret(shop.tapApiKey),
      myfatoorahApiKey: maskSecret(shop.myfatoorahApiKey),
      geminiApiKey: maskSecret(shop.geminiApiKey),
      openaiApiKey: maskSecret(shop.openaiApiKey),
      ultramsgToken: maskSecret(shop.ultramsgToken),
      monthlyOrdersCount,
    };

    const now = Date.now();
    const end = shop.subscriptionEnd ? new Date(shop.subscriptionEnd).getTime() : 0;
    const diffTime = end - now;
    const daysRemaining = Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
    const isExpired = end ? now > end : true;

    res.json({
      ...details,
      daysRemaining,
      isExpired: isExpired || shop.subscriptionStatus !== 'ACTIVE',
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.put('/shop/details', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const {
    name,
    email,
    whatsappType,
    whatsappPhoneId,
    whatsappToken,
    whatsappVerifyToken,
    paymentGateway,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeSuccessUrl,
    stripeCancelUrl,
    moyasarApiKey,
    tapApiKey,
    myfatoorahApiKey,
    whatsappAdminGroupId,
    aiProvider,
    geminiApiKey,
    openaiApiKey,
    logoUrl,
    ownerPhone,
    ultramsgInstanceId,
    ultramsgToken,
    deliveryStartHour,
    deliveryEndHour,
    enableDelivery,
    enablePickup,
    enableOnlinePayment,
    enableCashPayment,
    enableBankTransfer,
    bankAccounts,
    password,
  } = req.body;

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) return res.status(404).json({ error: 'المتجر غير موجود' });
    const plan = shop.subscriptionPlan || 'SILVER';

    let finalStripeSecretKey = stripeSecretKey;
    let finalStripeWebhookSecret = stripeWebhookSecret;
    let finalMoyasarApiKey = moyasarApiKey;
    let finalTapApiKey = tapApiKey;
    let finalMyfatoorahApiKey = myfatoorahApiKey;
    let finalWhatsappAdminGroupId = whatsappAdminGroupId;
    let finalOpenaiApiKey = openaiApiKey;
    let finalGeminiApiKey = geminiApiKey;
    let finalAutoPostStatus = req.body.autoPostStatus !== undefined ? req.body.autoPostStatus : false;

    if (plan === 'SILVER') {
      finalStripeSecretKey = undefined;
      finalStripeWebhookSecret = undefined;
      finalMoyasarApiKey = undefined;
      finalTapApiKey = undefined;
      finalMyfatoorahApiKey = undefined;
      finalWhatsappAdminGroupId = undefined;
      finalOpenaiApiKey = undefined;
      finalGeminiApiKey = undefined;
      finalAutoPostStatus = false;
    } else if (plan === 'GOLD') {
      finalOpenaiApiKey = undefined;
      finalGeminiApiKey = undefined;
      // GOLD now has Auto Status Post, so we don't disable it here.
    }

    const updateData: any = {
      name,
      whatsappType: whatsappType || 'BUSINESS',
      whatsappPhoneId: whatsappPhoneId || null,
      stripeSuccessUrl: stripeSuccessUrl || null,
      stripeCancelUrl: stripeCancelUrl || null,
      whatsappAdminGroupId: finalWhatsappAdminGroupId || null,
      aiProvider: aiProvider || 'OPENAI',
      logoUrl: logoUrl !== undefined ? (logoUrl || null) : undefined,
      ownerPhone: ownerPhone !== undefined ? (ownerPhone || null) : undefined,
      ultramsgInstanceId: ultramsgInstanceId || null,
      deliveryStartHour: deliveryStartHour || '09:00',
      deliveryEndHour: deliveryEndHour || '22:00',
      enableDelivery: enableDelivery !== undefined ? enableDelivery : true,
      enablePickup: enablePickup !== undefined ? enablePickup : true,
      enableOnlinePayment: enableOnlinePayment !== undefined ? enableOnlinePayment : true,
      enableCashPayment: enableCashPayment !== undefined ? enableCashPayment : false,
      enableBankTransfer: enableBankTransfer !== undefined ? enableBankTransfer : false,
      bankAccounts: bankAccounts !== undefined ? bankAccounts : "[]",
      autoPostStatus: finalAutoPostStatus,
      autoPostStatusTime: req.body.autoPostStatusTime || '10:00',
    };

    // Email update (kept valid + unique so password recovery keeps working).
    // An empty value is treated as "no change" so shops created before email
    // became mandatory can still save other settings.
    if (typeof email === 'string' && email.trim() !== '') {
      if (!isValidEmail(email)) {
        return res.status(400).json({ error: 'يرجى تقديم بريد إلكتروني صالح.' });
      }
      const normalizedEmail = email.trim().toLowerCase();
      const clash = await prisma.shop.findFirst({
        where: { email: normalizedEmail, NOT: { id: shopId } },
      });
      if (clash) {
        return res.status(400).json({ error: 'هذا البريد الإلكتروني مستخدم من قبل متجر آخر.' });
      }
      updateData.email = normalizedEmail;
    }

    // Secret fields: only overwrite when a genuinely new value is supplied.
    // The dashboard receives masked values (prefixed with •); echoing those back
    // must NOT clobber the stored secret. An empty string clears the field.
    const applySecret = (field: string, value: unknown) => {
      if (value === undefined) return; // field not sent → leave unchanged
      const str = typeof value === 'string' ? value : '';
      if (str.startsWith('••••')) return; // masked placeholder → leave unchanged
      updateData[field] = str.trim() || null;
    };

    applySecret('whatsappToken', whatsappToken);
    applySecret('whatsappVerifyToken', whatsappVerifyToken);
    applySecret('stripeSecretKey', finalStripeSecretKey);
    applySecret('stripeWebhookSecret', finalStripeWebhookSecret);
    applySecret('moyasarApiKey', finalMoyasarApiKey);
    applySecret('tapApiKey', finalTapApiKey);
    applySecret('myfatoorahApiKey', finalMyfatoorahApiKey);
    applySecret('geminiApiKey', finalGeminiApiKey);
    applySecret('openaiApiKey', finalOpenaiApiKey);
    applySecret('ultramsgToken', ultramsgToken);

    if (password) {
      updateData.password = await hashPassword(password);
    }

    await prisma.shop.update({
      where: { id: shopId },
      data: updateData,
    });

    res.json({ message: 'تم تحديث إعدادات المتجر بنجاح' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// -------------------------------------------------------------
// Subscription Renewal Payment Route (SaaS Platform Stripe)
// -------------------------------------------------------------
router.post('/shop/subscription/checkout', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { plan, durationMonths } = req.body;

  if (!plan || !durationMonths) {
    return res.status(400).json({ error: 'يرجى اختيار الباقة وفترة الاشتراك المطلوبة' });
  }

  const allowedPlans = ['SILVER', 'GOLD', 'PLATINUM'];
  if (!allowedPlans.includes(plan)) {
    return res.status(400).json({ error: 'باقة الاشتراك المحددة غير صالحة' });
  }

  const duration = parseInt(durationMonths);
  const allowedDurations = [1, 3, 6, 12];
  if (!allowedDurations.includes(duration)) {
    return res.status(400).json({ error: 'فترة الاشتراك المحددة غير صالحة' });
  }

  const platformStripe = settings.getPlatformStripe();
  if (!platformStripe.secretKey) {
    return res.status(500).json({ error: 'بوابة دفع المنصة (Stripe) غير مهيأة حالياً. يرجى التواصل مع الإدارة للتفعيل.' });
  }

  try {
    // 1. Calculate pricing from platform settings (admin-editable).
    const monthlyPrice = settings.getPlanPrice(plan);
    const discount = settings.getDiscountFraction(duration);
    const totalPrice = Math.round(monthlyPrice * duration * (1 - discount));

    if (!totalPrice || totalPrice <= 0) {
      return res.status(500).json({ error: 'سعر الباقة غير مهيأ بشكل صحيح. يرجى التواصل مع الإدارة.' });
    }

    // 2. Create Stripe Checkout session on behalf of the platform
    const Stripe = require('stripe');
    const stripe = new Stripe(platformStripe.secretKey, {
      apiVersion: '2025-04-30.basil' as any,
    });

    const origin = req.headers.origin || settings.getAppBaseUrl();

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'sar',
            product_data: {
              name: `تجديد اشتراك المتجر - باقة ${plan === 'SILVER' ? 'الفضية' : plan === 'GOLD' ? 'الذهبية' : 'البلاتينية'}`,
              description: `المدة: ${duration} أشهر (بسعر شهري ${monthlyPrice} ريال)`,
            },
            unit_amount: totalPrice * 100, // in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${origin}/dashboard?payment=success`,
      cancel_url: `${origin}/dashboard?payment=cancel`,
      metadata: {
        type: 'subscription_renewal',
        shopId: shopId,
        plan: plan,
        durationMonths: duration.toString(),
      },
    });

    res.json({ url: session.url });
  } catch (err: any) {
    logger.error(`[Billing] Failed to create subscription checkout: ${err.message}`);
    res.status(500).json({ error: 'فشل في إعداد عملية الدفع، يرجى المحاولة لاحقاً.' });
  }
});

// -------------------------------------------------------------
// WhatsApp Built-in Session Management (Free Standard WhatsApp)
// -------------------------------------------------------------
router.get('/shop/whatsapp/status', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { getSessionStatus } = require('../services/baileys-manager');
  const session = getSessionStatus(shopId);

  res.json({
    status: session.status,
    hasQr: !!session.qr,
  });
});

router.get('/shop/whatsapp/debug', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { getSessionStatus, activeSockets, lastErrors } = require('../services/baileys-manager');
  const session = getSessionStatus(shopId);
  res.json({
    shopId,
    sessionStatus: session.status,
    hasQr: !!session.qr,
    hasSocket: !!activeSockets?.get?.(shopId),
    lastError: lastErrors?.get?.(shopId) || 'No error recorded'
  });
});

router.get('/shop/whatsapp/groups', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { activeSockets } = require('../services/baileys-manager');
  const sock = activeSockets?.get?.(shopId);
  
  if (!sock) {
    return res.status(400).json({ error: 'WhatsApp is not connected' });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = Object.values(groups).map((g: any) => ({
      id: g.id,
      subject: g.subject
    }));
    res.json(groupList);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to fetch groups', details: err.message });
  }
});

router.get('/shop/whatsapp/qr', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { startBaileysSession, getSessionStatus, generateQrCodeImage } = require('../services/baileys-manager');

  let session = getSessionStatus(shopId);

  // If disconnected, start a new session
  if (session.status === 'DISCONNECTED') {
    await startBaileysSession(shopId);
    // Wait briefly for QR to generate
    await new Promise((resolve) => setTimeout(resolve, 3000));
    session = getSessionStatus(shopId);
  }

  if (session.qr) {
    try {
      const qrImage = await generateQrCodeImage(session.qr);
      return res.json({ qr: qrImage, status: session.status });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to generate QR code image' });
    }
  }

  res.json({ status: session.status });
});

router.post('/shop/whatsapp/logout', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { logoutSession } = require('../services/baileys-manager');
  
  try {
    await logoutSession(shopId);
    res.json({ message: 'تم تسجيل الخروج وفصل الواتساب بنجاح' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.get('/shop/products', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const products = await prisma.product.findMany({
      where: { shopId },
      orderBy: { name: 'asc' },
    });
    res.json(products);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.post('/shop/products', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { name, description, price, imageUrl, category, available, stock } = req.body;

  if (!name || price === undefined) {
    return res.status(400).json({ error: 'يرجى تقديم اسم المنتج وسعره' });
  }

  try {
    const product = await prisma.product.create({
      data: {
        shopId,
        name,
        description: description || '',
        price: parseFloat(price),
        imageUrl: imageUrl || '',
        category: category || 'عام',
        available: available !== undefined ? available : true,
        stock: stock !== undefined ? parseInt(stock) : 10,
      },
    });
    res.status(201).json(product);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.put('/shop/products/:id', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { name, description, price, imageUrl, category, available, stock } = req.body;

  try {
    // Ensure product belongs to this shop
    const product = await prisma.product.findFirst({
      where: { id: req.params.id as string, shopId },
    });

    if (!product) {
      return res.status(404).json({ error: 'المنتج غير موجود أو لا تملك صلاحية تعديله' });
    }

    const updated = await prisma.product.update({
      where: { id: req.params.id as string },
      data: {
        name,
        description,
        price: price !== undefined ? parseFloat(price) : undefined,
        imageUrl,
        category,
        available,
        stock: stock !== undefined ? parseInt(stock) : undefined,
      },
    });

    res.json(updated);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.delete('/shop/products/:id', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    // Ensure product belongs to this shop
    const product = await prisma.product.findFirst({
      where: { id: req.params.id as string, shopId },
    });

    if (!product) {
      return res.status(404).json({ error: 'المنتج غير موجود أو لا تملك صلاحية حذفه' });
    }

    await prisma.product.delete({
      where: { id: req.params.id as string },
    });

    res.json({ message: 'تم حذف المنتج بنجاح' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.post('/shop/products/:id/status', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop || shop.whatsappType !== 'NORMAL') {
      return res.status(400).json({ error: 'ميزة الحالات متوفرة فقط عند ربط الواتساب عبر مسح الكود (Baileys).' });
    }

    const product = await prisma.product.findFirst({
      where: { id: req.params.id as string, shopId },
    });

    if (!product) {
      return res.status(404).json({ error: 'المنتج غير موجود' });
    }

    const { postWhatsAppStatus } = require('../services/baileys-manager');
    const count = await postWhatsAppStatus(shopId, product);

    res.json({ message: `تم نشر المنتج كحالة واتساب بنجاح! تم إرسالها إلى ${count} عميل.` });
  } catch (err: any) {
    logger.error(`[API] Status post error: ${err.message}`);
    res.status(500).json({ error: err.message || 'حدث خطأ أثناء النشر.' });
  }
});


router.get('/shop/orders', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const orders = await prisma.order.findMany({
      where: { shopId },
      orderBy: { timestamp: 'desc' },
    });
    res.json(orders);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// Update an order's status (cancel / confirm / mark delivered / etc.) — shop-scoped.
const ORDER_STATUSES = ['PENDING', 'CONFIRMED', 'CANCELLED', 'DELIVERED', 'FAILED'];
router.put('/shop/orders/:id', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { status, orderStatus } = req.body || {};

  try {
    const order = await prisma.order.findFirst({ where: { id: req.params.id as string, shopId }, include: { shop: true } });
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

    const updateData: any = {};
    // @ts-ignore (ignoring ORDER_STATUSES check for safety since we don't have its full definition here)
    if (status) updateData.paymentStatus = status;
    if (orderStatus) updateData.orderStatus = orderStatus;

    if (Object.keys(updateData).length === 0) return res.status(400).json({ error: 'بيانات التحديث غير صالحة' });

    await prisma.order.update({ where: { id: order.id }, data: updateData });

    // Cancelling/failing an order frees the customer's chat session
    if (status === 'CANCELLED' || status === 'FAILED') {
      await prisma.session.updateMany({
        where: { phone: order.customerPhone, shopId },
        data: { state: 'GREETING', orderData: '{}', botPaused: false }
      });
    }

    // Send WhatsApp notification when order is delivered
    if (orderStatus === 'DELIVERED' && order.orderStatus !== 'DELIVERED') {
      const whatsappConfig = {
        whatsappType: order.shop.whatsappType as 'BUSINESS' | 'NORMAL',
        shopId: order.shop.id,
        token: order.shop.whatsappToken,
        phoneId: order.shop.whatsappPhoneId,
      };
      const deliveredMsg = `مرحباً ${order.customerName}،\n\nيسعدنا إخبارك بأنه قد تم تسليم طلبك بنجاح! 🎉\nنأمل أن ينال إعجابك، ونتمنى رؤيتك قريباً.\n\nمع تحيات: *${order.shop.name}* 🌹`;
      try {
        await sendTextMessage(whatsappConfig, order.customerPhone, deliveredMsg);
        logger.info(`[Delivery Notification] Sent to ${maskPhone(order.customerPhone)} for order ${order.id}`);
      } catch (err: any) {
        logger.error(`[Delivery Notification] Failed to send to ${maskPhone(order.customerPhone)}: ${err.message}`);
      }
    }

    res.json({ message: 'تم تحديث حالة الطلب بنجاح' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// Broadcast Campaign (WhatsApp)
router.post('/shop/campaign', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { message, audience } = req.body;

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'الرسالة مطلوبة' });
  }

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) return res.status(404).json({ error: 'المتجر غير موجود' });

    // Fetch unique customer phones from orders
    const orders = await prisma.order.findMany({
      where: { shopId },
      select: { customerPhone: true },
      distinct: ['customerPhone'],
    });

    const phones = orders.map(o => o.customerPhone).filter(Boolean);
    if (phones.length === 0) {
      return res.status(400).json({ error: 'لا يوجد عملاء سابقين لإرسال الحملة لهم' });
    }

    // Acknowledge immediately so the UI doesn't hang
    res.json({ message: `جاري إرسال الحملة لـ ${phones.length} عميل في الخلفية...` });

    const whatsappConfig = {
      whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
      shopId: shop.id,
      token: shop.whatsappToken,
      phoneId: shop.whatsappPhoneId,
    };

    // Run in background
    setTimeout(async () => {
      logger.info(`[Campaign] Starting campaign for shop ${shop.id} to ${phones.length} customers.`);
      for (const phone of phones) {
        try {
          await sendTextMessage(whatsappConfig, phone, message);
          // Anti-ban delay: Random between 10s and 20s ONLY for NORMAL (Free WhatsApp)
          if (whatsappConfig.whatsappType !== 'BUSINESS') {
            const delay = Math.floor(Math.random() * 10000) + 10000;
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } catch (err: any) {
          logger.error(`[Campaign] Failed to send to ${maskPhone(phone)}: ${err.message}`);
        }
      }
      logger.info(`[Campaign] Completed campaign for shop ${shop.id}.`);
    }, 0);

  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'حدث خطأ في الخادم' });
  }
});

// Delete an order — shop-scoped.
router.delete('/shop/orders/:id', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const order = await prisma.order.findFirst({ where: { id: req.params.id as string, shopId } });
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

    await prisma.order.delete({ where: { id: order.id } });
    // Also free the customer's chat session so the bot doesn't keep asking for payment, but preserve history.
    await prisma.session.updateMany({
      where: { phone: order.customerPhone, shopId },
      data: { state: 'GREETING', orderData: '{}', botPaused: false }
    });
    res.json({ message: 'تم حذف الطلب' });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

router.get('/shop/analytics', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    // 1. Fetch orders
    const orders = await prisma.order.findMany({
      where: { shopId },
      orderBy: { timestamp: 'asc' },
    });

    // 2. Fetch products for restock alerts
    const products = await prisma.product.findMany({
      where: { shopId },
    });

    const confirmedOrders = orders.filter((o) => o.paymentStatus === 'CONFIRMED' || o.paymentStatus === 'DELIVERED');
    const totalOrders = orders.length;
    const confirmedCount = confirmedOrders.length;
    const pendingCount = orders.filter((o) => o.paymentStatus === 'PENDING').length;
    const failedCount = orders.filter((o) => o.paymentStatus === 'FAILED').length;

    const totalRevenue = confirmedOrders.reduce((sum, o) => sum + o.price, 0);
    const aov = confirmedCount ? parseFloat((totalRevenue / confirmedCount).toFixed(2)) : 0;

    // 3. Group Sales by Product
    const productSalesMap: Record<string, { count: number; revenue: number }> = {};
    confirmedOrders.forEach((o) => {
      if (!productSalesMap[o.productName]) {
        productSalesMap[o.productName] = { count: 0, revenue: 0 };
      }
      productSalesMap[o.productName].count += 1;
      productSalesMap[o.productName].revenue += o.price;
    });

    const salesByProduct = Object.keys(productSalesMap).map((name) => ({
      productName: name,
      count: productSalesMap[name].count,
      totalRevenue: productSalesMap[name].revenue,
    })).sort((a, b) => b.totalRevenue - a.totalRevenue);

    // 4. Daily Sales Trend (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const dailyMap: Record<string, { revenue: number; count: number }> = {};
    // Pre-populate last 30 days with 0s to avoid empty spots
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      dailyMap[dateStr] = { revenue: 0, count: 0 };
    }

    confirmedOrders.forEach((o) => {
      const dateStr = new Date(o.timestamp).toISOString().split('T')[0];
      if (dailyMap[dateStr] !== undefined) {
        dailyMap[dateStr].revenue += o.price;
        dailyMap[dateStr].count += 1;
      }
    });

    const dailySales = Object.keys(dailyMap).map((date) => ({
      date,
      revenue: dailyMap[date].revenue,
      count: dailyMap[date].count,
    })).sort((a, b) => a.date.localeCompare(b.date));

    // 5. Predictive Analytics calculations
    // Forecast next week based on daily average of the last 30 days
    const totalRevenueLast30 = dailySales.reduce((sum, d) => sum + d.revenue, 0);
    const avgDailySalesLast30 = totalRevenueLast30 / 30;
    const forecastedSalesNextWeek = parseFloat((avgDailySalesLast30 * 7).toFixed(2));

    // Calculate growth rate (sales last 7 days vs previous 7 days)
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const salesLast7 = confirmedOrders
      .filter((o) => new Date(o.timestamp) >= sevenDaysAgo)
      .reduce((sum, o) => sum + o.price, 0);

    const salesPrev7 = confirmedOrders
      .filter((o) => {
        const d = new Date(o.timestamp);
        return d >= fourteenDaysAgo && d < sevenDaysAgo;
      })
      .reduce((sum, o) => sum + o.price, 0);

    const growthRate = salesPrev7 > 0 ? parseFloat((((salesLast7 - salesPrev7) / salesPrev7) * 100).toFixed(2)) : 0;

    // Busiest Day of week (0 = Sunday, 1 = Monday, ..., 6 = Saturday)
    const dayOfWeekOrdersCount = [0, 0, 0, 0, 0, 0, 0];
    const dayOfWeekSalesAmount = [0, 0, 0, 0, 0, 0, 0];
    confirmedOrders.forEach((o) => {
      const day = new Date(o.timestamp).getDay();
      dayOfWeekOrdersCount[day] += 1;
      dayOfWeekSalesAmount[day] += o.price;
    });

    const arabicDays = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
    let busiestDayIdx = 0;
    let maxOrders = 0;
    for (let i = 0; i < 7; i++) {
      if (dayOfWeekOrdersCount[i] > maxOrders) {
        maxOrders = dayOfWeekOrdersCount[i];
        busiestDayIdx = i;
      }
    }
    const busiestDay = maxOrders > 0 ? arabicDays[busiestDayIdx] : 'لا يوجد بيانات كافية';
    const predictedBusiestDayNextWeek = busiestDay;

    const salesByDayOfWeek = arabicDays.map((dayName, idx) => ({
      dayName,
      count: dayOfWeekOrdersCount[idx],
      revenue: dayOfWeekSalesAmount[idx],
    }));

    // Hourly Sales distribution (24 hours)
    const hourlyOrdersCount = Array(24).fill(0);
    const hourlySalesAmount = Array(24).fill(0);
    confirmedOrders.forEach((o) => {
      const hour = new Date(o.timestamp).getHours();
      hourlyOrdersCount[hour] += 1;
      hourlySalesAmount[hour] += o.price;
    });

    const salesByHour = hourlyOrdersCount.map((count, hour) => ({
      hour: `${hour.toString().padStart(2, '0')}:00`,
      count,
      revenue: hourlySalesAmount[hour],
    }));

    // Customer Loyalty / Retention
    const customerOrdersMap: Record<string, number> = {};
    confirmedOrders.forEach((o) => {
      customerOrdersMap[o.customerPhone] = (customerOrdersMap[o.customerPhone] || 0) + 1;
    });

    const uniqueCustomers = Object.keys(customerOrdersMap).length;
    const repeatCustomers = Object.values(customerOrdersMap).filter((count) => count > 1).length;
    const repeatCustomerRate = uniqueCustomers > 0 ? parseFloat(((repeatCustomers / uniqueCustomers) * 100).toFixed(2)) : 0;

    const topCustomers = Object.keys(customerOrdersMap)
      .map((phone) => {
        const custOrders = confirmedOrders.filter(o => o.customerPhone === phone);
        const name = custOrders[0]?.customerName || 'غير معروف';
        const spent = custOrders.reduce((sum, o) => sum + o.price, 0);
        return { phone, name, spent, count: custOrders.length };
      })
      .sort((a, b) => b.spent - a.spent)
      .slice(0, 5);

    // Order status percentages
    const confirmedPercentage = totalOrders > 0 ? parseFloat(((confirmedCount / totalOrders) * 100).toFixed(2)) : 0;
    const pendingPercentage = totalOrders > 0 ? parseFloat(((pendingCount / totalOrders) * 100).toFixed(2)) : 0;
    const failedPercentage = totalOrders > 0 ? parseFloat(((failedCount / totalOrders) * 100).toFixed(2)) : 0;

    const fulfillmentBreakdown = {
      pickup: confirmedOrders.filter(o => o.fulfillmentType === 'PICKUP').length,
      delivery: confirmedOrders.filter(o => o.fulfillmentType === 'DELIVERY').length
    };

    // Restock alerts and detailed product stock out forecasts
    const restockAlerts: string[] = [];
    const productProjections = products.map((p) => {
      const productOrders = confirmedOrders.filter((o) => o.productName === p.name);
      const productOrdersLast30 = productOrders.filter((o) => new Date(o.timestamp) >= thirtyDaysAgo).length;
      const velocity = productOrdersLast30 / 30; // sales per day
      const daysToStockOut = velocity > 0 ? p.stock / velocity : 999;

      if (p.stock <= 3) {
        restockAlerts.push(`⚠️ المنتج (${p.name}) مخزونه منخفض جداً: متبقي فقط ${p.stock} حبة في المخزن.`);
      } else if (daysToStockOut <= 5) {
        restockAlerts.push(`🔥 تحذير المخزون: مبيعات (${p.name}) متسارعة، ومن المتوقع نفاد الكمية خلال ${Math.ceil(daysToStockOut)} أيام.`);
      }

      return {
        id: p.id,
        name: p.name,
        stock: p.stock,
        velocity: parseFloat(velocity.toFixed(2)),
        daysToStockOut: daysToStockOut === 999 ? 'غير متوقع نفاد الكمية قريباً' : `${Math.ceil(daysToStockOut)} أيام`,
      };
    });

    const stagnantProducts = products.filter(p => {
      const productOrdersLast30 = confirmedOrders.filter((o) => o.productName === p.name && new Date(o.timestamp) >= thirtyDaysAgo).length;
      return productOrdersLast30 === 0 && p.stock > 0;
    }).map(p => ({ name: p.name, stock: p.stock }));

    // Forecast next month (30 days) revenue
    const forecastedSalesNextMonth = parseFloat((avgDailySalesLast30 * 30).toFixed(2));

    res.json({
      summary: {
        totalRevenue,
        totalOrders,
        aov,
        ordersStatusBreakdown: {
          confirmed: confirmedCount,
          pending: pendingCount,
          failed: failedCount,
          confirmedPercentage,
          pendingPercentage,
          failedPercentage,
        },
        loyalty: {
          uniqueCustomers,
          repeatCustomers,
          repeatCustomerRate,
        },
      },
      salesByProduct,
      dailySales,
      salesByDayOfWeek,
      salesByHour,
      productProjections,
      topCustomers,
      stagnantProducts,
      fulfillmentBreakdown,
      predictiveAnalytics: {
        forecastedSalesNextWeek,
        forecastedSalesNextMonth,
        growthRate,
        busiestDay,
        predictedBusiestDayNextWeek,
        restockAlerts,
      },
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// -------------------------------------------------------------
// 5. LIVE CHAT & MANUAL INTERVENTION ROUTES
// -------------------------------------------------------------

// Helper: safely serialize BigInt values in objects
function serializeBigInt(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigInt);
  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = serializeBigInt(obj[key]);
    }
    return result;
  }
  return obj;
}

// GET /api/shop/chats - List all active chat sessions for this shop
router.get('/shop/chats', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const sessions = await prisma.session.findMany({
      where: { shopId },
      orderBy: { lastActivity: 'desc' },
    });

    const chats = sessions.map((s) => {
      let messages: any[] = [];
      try {
        messages = JSON.parse(s.messages);
      } catch (e) {
        messages = [];
      }

      const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;

      return {
        phone: s.phone,
        state: s.state,
        botPaused: s.botPaused,
        lastActivity: s.lastActivity.toString(),
        lastMessage: lastMsg ? lastMsg.content : '',
        lastMessageRole: lastMsg ? lastMsg.role : '',
        messagesCount: messages.length,
      };
    });

    res.json(chats);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// GET /api/shop/chats/:phone - Get full conversation history for a customer
router.get('/shop/chats/:phone', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const phone = req.params.phone as string;

  try {
    const session = await prisma.session.findUnique({
      where: { phone_shopId: { phone, shopId } },
    });

    if (!session) {
      return res.status(404).json({ error: 'لا توجد محادثة نشطة لهذا الرقم' });
    }

    let messages: any[] = [];
    try {
      messages = JSON.parse(session.messages);
    } catch (e) {
      messages = [];
    }

    let orderData: any = {};
    try {
      orderData = JSON.parse(session.orderData);
    } catch (e) {
      orderData = {};
    }

    res.json({
      phone: session.phone,
      state: session.state,
      botPaused: session.botPaused,
      lastActivity: session.lastActivity.toString(),
      messages,
      orderData,
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// POST /api/shop/chats/:phone/toggle-bot - Toggle bot pause state for a customer
router.post('/shop/chats/:phone/toggle-bot', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const phone = req.params.phone as string;

  try {
    const session = await prisma.session.findUnique({
      where: { phone_shopId: { phone, shopId } },
    });

    if (!session) {
      return res.status(404).json({ error: 'لا توجد محادثة نشطة لهذا الرقم' });
    }

    const newState = !session.botPaused;

    await prisma.session.update({
      where: { phone_shopId: { phone, shopId } },
      data: { botPaused: newState },
    });

    res.json({
      phone,
      botPaused: newState,
      message: newState ? 'تم إيقاف البوت - يمكنك الآن التحدث مع الزبون مباشرة' : 'تم تفعيل البوت - سيعود للرد الآلي',
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// POST /api/shop/chats/:phone/send - Send a manual message from shop owner to customer
router.post('/shop/chats/:phone/send', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const phone = req.params.phone as string;
  const { message } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'يرجى كتابة رسالة قبل الإرسال' });
  }

  try {
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop) {
      return res.status(404).json({ error: 'المتجر غير موجود' });
    }

    const session = await prisma.session.findUnique({
      where: { phone_shopId: { phone, shopId } },
    });

    if (!session) {
      return res.status(404).json({ error: 'لا توجد محادثة نشطة لهذا الرقم' });
    }

    // 1. Send the message via WhatsApp
    const { sendTextMessage } = require('../services/whatsapp');
    const whatsappConfig = {
      whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
      shopId: shop.id,
      token: shop.whatsappToken || '',
      phoneId: shop.whatsappPhoneId || '',
      adminGroupId: shop.whatsappAdminGroupId,
      ultramsgInstanceId: shop.ultramsgInstanceId,
      ultramsgToken: shop.ultramsgToken,
    };

    await sendTextMessage(whatsappConfig, phone, message.trim());

    // 2. Record the message in the session history
    let messages: any[] = [];
    try {
      messages = JSON.parse(session.messages);
    } catch (e) {
      messages = [];
    }

    messages.push({ role: 'assistant', content: `[تدخل يدوي] ${message.trim()}` });

    // Trim old messages if needed
    if (messages.length > 20) {
      messages = messages.slice(-10);
    }

    // 3. Auto-pause the bot when shop owner sends a manual message
    await prisma.session.update({
      where: { phone_shopId: { phone, shopId } },
      data: {
        messages: JSON.stringify(messages),
        botPaused: true,
        lastActivity: BigInt(Date.now()),
      },
    });

    res.json({
      success: true,
      message: 'تم إرسال الرسالة للزبون بنجاح وتم إيقاف البوت تلقائياً',
    });
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم. يرجى المحاولة لاحقاً.' });
  }
});

// GET /api/shop/blocked-customers - List blocked customers
router.get('/shop/blocked-customers', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const blocked = await prisma.blockedCustomer.findMany({
      where: { shopId },
      orderBy: { createdAt: 'desc' }
    });
    res.json(blocked);
  } catch (err: any) {
    logger.error(`[API] ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ في الخادم.' });
  }
});

// POST /api/shop/chats/:phone/block - Block a customer
router.post('/shop/chats/:phone/block', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const phone = req.params.phone as string;
  const { reason } = req.body || {};

  try {
    await prisma.blockedCustomer.upsert({
      where: { shopId_phone: { shopId, phone } },
      update: { reason },
      create: { shopId, phone, reason }
    });

    // Delete their active session so bot won't even see them
    await prisma.session.deleteMany({
      where: { shopId, phone }
    });

    res.json({ message: 'تم حظر المستخدم بنجاح ولن يستطيع استخدام الخدمة.' });
  } catch (err: any) {
    logger.error(`[API] Block user error: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ أثناء حظر المستخدم.' });
  }
});

// DELETE /api/shop/chats/:phone/block - Unblock a customer
router.delete('/shop/chats/:phone/block', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const phone = req.params.phone as string;

  try {
    await prisma.blockedCustomer.deleteMany({
      where: { shopId, phone }
    });
    res.json({ message: 'تم إزالة الحظر عن المستخدم.' });
  } catch (err: any) {
    logger.error(`[API] Unblock user error: ${err.message}`);
    res.status(500).json({ error: 'حدث خطأ أثناء إزالة الحظر.' });
  }
});

import { handleGenericPaymentSuccess } from '../agents/agent-4-finance';
import { verifyMoyasarPayment, PaymentVerification } from '../services/moyasar-service';
import { verifyTapPayment } from '../services/tap-service';
import { verifyMyFatoorahPayment } from '../services/myfatoorah-service';

// ==========================================
// Webhooks for Payment Gateways
// ==========================================
//
// SECURITY: these webhooks are PUBLIC and UNSIGNED at the transport level, so the
// request body proves nothing. We treat the body only as a hint ("order X may have
// paid"), then independently re-query the gateway's API (with the shop's own key)
// to confirm the payment is real and the amount matches before confirming the order.
// This blocks forged "status: paid" requests that would otherwise grant free orders.

type GatewayVerifier = (apiKey: string | null, sessionId: string) => Promise<PaymentVerification>;

async function confirmVerifiedPayment(
  orderId: string,
  gatewayName: 'MOYASAR' | 'TAP' | 'MYFATOORAH',
  keyOf: (shop: any) => string | null,
  verify: GatewayVerifier
): Promise<void> {
  if (!orderId) return;

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    logger.warn(`[${gatewayName} Webhook] Unknown order ${orderId}; ignoring.`);
    return;
  }
  if (order.paymentStatus === 'CONFIRMED') return; // idempotent

  if (!order.stripeSessionId) {
    logger.warn(`[${gatewayName} Webhook] Order ${orderId} has no payment session; cannot verify.`);
    return;
  }

  const shop = await prisma.shop.findUnique({ where: { id: order.shopId } });
  if (!shop) return;

  // Authoritative check against the gateway — NOT the request body.
  const verification = await verify(keyOf(shop), order.stripeSessionId);
  if (!verification.paid) {
    logger.warn(`[${gatewayName} Webhook] Gateway did NOT confirm payment for order ${orderId}; rejecting.`);
    return;
  }

  // Guard against amount tampering: the verified amount must match the order price.
  if (Math.abs(verification.amount - order.price) > 0.5) {
    logger.error(
      `[${gatewayName} Webhook] SECURITY: amount mismatch for order ${orderId} ` +
      `(gateway=${verification.amount}, order=${order.price}); rejecting.`
    );
    return;
  }

  await handleGenericPaymentSuccess({
    sessionId: order.stripeSessionId,
    orderId: order.id,
    shopId: order.shopId,
    customerPhone: order.customerPhone || '',
    customerName: order.customerName || 'Customer',
    amount: order.price,
    gatewayName,
  });
}

router.post('/webhook/moyasar', async (req, res) => {
  // Acknowledge immediately; Moyasar retries on slow responses.
  res.json({ received: true });
  try {
    const orderId = req.body?.metadata?.orderId;
    await confirmVerifiedPayment(orderId, 'MOYASAR', (s) => s.moyasarApiKey, verifyMoyasarPayment);
  } catch (err: any) {
    logger.error(`[Moyasar Webhook] Error: ${err.message}`);
  }
});

router.post('/webhook/tap', async (req, res) => {
  res.json({ received: true });
  try {
    const orderId = req.body?.metadata?.orderId;
    await confirmVerifiedPayment(orderId, 'TAP', (s) => s.tapApiKey, verifyTapPayment);
  } catch (err: any) {
    logger.error(`[Tap Webhook] Error: ${err.message}`);
  }
});

router.post('/webhook/myfatoorah', async (req, res) => {
  res.json({ received: true });
  try {
    const orderId = req.body?.Data?.CustomerReference;
    await confirmVerifiedPayment(orderId, 'MYFATOORAH', (s) => s.myfatoorahApiKey, verifyMyFatoorahPayment);
  } catch (err: any) {
    logger.error(`[MyFatoorah Webhook] Error: ${err.message}`);
  }
});

export default router;

