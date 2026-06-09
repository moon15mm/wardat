import { Router } from 'express';
import prisma from '../services/db';
import { hashPassword, generateToken } from '../utils/auth';
import { authenticateSuperAdmin, authenticateShop } from '../middlewares/auth';

const router = Router();

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
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';

  if (username === adminUser && password === adminPass) {
    const token = generateToken({ role: 'superadmin' });
    return res.json({ token, role: 'superadmin', name: 'مدير النظام' });
  }

  // Check if it matches a Shop in database
  try {
    const shop = await prisma.shop.findUnique({
      where: { username },
    });

    if (shop && hashPassword(password) === shop.password) {
      const token = generateToken({ role: 'shop', shopId: shop.id });
      return res.json({ token, role: 'shop', shopId: shop.id, name: shop.name });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'حدث خطأ في الاتصال بقاعدة البيانات' });
  }

  return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
        whatsappType: s.whatsappType,
        whatsappPhoneId: s.whatsappPhoneId,
        aiProvider: s.aiProvider,
        geminiApiKey: s.geminiApiKey,
        ultramsgInstanceId: s.ultramsgInstanceId,
        ultramsgToken: s.ultramsgToken,
        createdAt: s.createdAt,
        productsCount: s._count.products,
        ordersCount: s._count.orders,
        subscriptionPlan: s.subscriptionPlan,
        subscriptionEnd: s.subscriptionEnd,
        subscriptionStatus: s.subscriptionStatus,
      }))
    );
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/shops', authenticateSuperAdmin, async (req, res) => {
  const {
    name,
    subdomain,
    username,
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
    ultramsgInstanceId,
    ultramsgToken,
    subscriptionPlan,
    subscriptionDurationMonths,
  } = req.body;

  if (!name || !subdomain || !username || !password) {
    return res.status(400).json({ error: 'يرجى تقديم اسم المتجر، الدومين الفرعي، اسم المستخدم وكلمة المرور' });
  }

  try {
    const existingShop = await prisma.shop.findFirst({
      where: {
        OR: [{ subdomain }, { username }],
      },
    });

    if (existingShop) {
      return res.status(400).json({
        error: 'اسم المستخدم أو الدومين الفرعي مسجل مسبقاً لمتجر آخر',
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
    const subscriptionEnd = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000);

    const shop = await prisma.shop.create({
      data: {
        name,
        subdomain,
        username,
        password: hashPassword(password),
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
        ultramsgInstanceId: ultramsgInstanceId || null,
        ultramsgToken: ultramsgToken || null,
        subscriptionPlan: subscriptionPlan || 'SILVER',
        subscriptionStatus: 'ACTIVE',
        subscriptionEnd: subscriptionEnd,
      },
    });

    res.status(201).json(shop);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/shops/:id', authenticateSuperAdmin, async (req, res) => {
  try {
    await prisma.shop.delete({
      where: { id: req.params.id as string },
    });
    res.json({ message: 'تم حذف المتجر وبياناته بنجاح' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/admin/shops/:id', authenticateSuperAdmin, async (req, res) => {
  const { subscriptionPlan, subscriptionDurationMonths, subscriptionStatus } = req.body;

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

    if (subscriptionDurationMonths) {
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

    res.json({ message: 'تم تحديث خطة اشتراك المتجر بنجاح', shop: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

router.get('/shop/details', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
    });
    if (!shop) return res.status(404).json({ error: 'Shop not found' });

    // Do not return hashed password
    const { password, ...details } = shop;

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
    res.status(500).json({ error: err.message });
  }
});

router.put('/shop/details', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const {
    name,
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
    ultramsgInstanceId,
    ultramsgToken,
    password,
  } = req.body;

  try {
    const updateData: any = {
      name,
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
      ultramsgInstanceId: ultramsgInstanceId || null,
      ultramsgToken: ultramsgToken || null,
    };

    if (password) {
      updateData.password = hashPassword(password);
    }

    await prisma.shop.update({
      where: { id: shopId },
      data: updateData,
    });

    res.json({ message: 'تم تحديث إعدادات المتجر بنجاح' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'بوابة دفع المنصة (Stripe) غير مهيأة حالياً. يرجى التواصل مع الإدارة للتفعيل.' });
  }

  try {
    // 1. Calculate pricing
    let monthlyPrice = 150; // default GOLD
    if (plan === 'SILVER') monthlyPrice = 50;
    else if (plan === 'PLATINUM') monthlyPrice = 300;

    // Apply discounts: 3 months (5%), 6 months (10%), 12 months (20%)
    let discount = 0;
    if (duration === 3) discount = 0.05;
    else if (duration === 6) discount = 0.10;
    else if (duration === 12) discount = 0.20;

    const totalPrice = Math.round(monthlyPrice * duration * (1 - discount));

    // 2. Create Stripe Checkout session on behalf of the platform
    const Stripe = require('stripe');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2025-04-30.basil' as any,
    });

    const origin = req.headers.origin || 'https://wardat.xyz';

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

router.post('/shop/products', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { name, description, price, imageUrl, category, available } = req.body;

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
      },
    });
    res.status(201).json(product);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/shop/products/:id', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const { name, description, price, imageUrl, category, available } = req.body;

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
      },
    });

    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

export default router;
