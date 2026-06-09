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
        whatsappPhoneId: s.whatsappPhoneId,
        createdAt: s.createdAt,
        productsCount: s._count.products,
        ordersCount: s._count.orders,
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
    whatsappPhoneId,
    whatsappToken,
    whatsappVerifyToken,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeSuccessUrl,
    stripeCancelUrl,
    whatsappAdminGroupId,
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

    const shop = await prisma.shop.create({
      data: {
        name,
        subdomain,
        username,
        password: hashPassword(password),
        whatsappPhoneId: whatsappPhoneId || null,
        whatsappToken: whatsappToken || null,
        whatsappVerifyToken: whatsappVerifyToken || null,
        stripeSecretKey: stripeSecretKey || null,
        stripeWebhookSecret: stripeWebhookSecret || null,
        stripeSuccessUrl: stripeSuccessUrl || null,
        stripeCancelUrl: stripeCancelUrl || null,
        whatsappAdminGroupId: whatsappAdminGroupId || null,
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
    res.json(details);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/shop/details', authenticateShop, async (req, res) => {
  const shopId = (req as any).shopId;
  const {
    name,
    whatsappPhoneId,
    whatsappToken,
    whatsappVerifyToken,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeSuccessUrl,
    stripeCancelUrl,
    whatsappAdminGroupId,
    password,
  } = req.body;

  try {
    const updateData: any = {
      name,
      whatsappPhoneId,
      whatsappToken,
      whatsappVerifyToken,
      stripeSecretKey,
      stripeWebhookSecret,
      stripeSuccessUrl,
      stripeCancelUrl,
      whatsappAdminGroupId: whatsappAdminGroupId || null,
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
