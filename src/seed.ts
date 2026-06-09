import prisma from './services/db';
import { hashPassword } from './utils/auth';

async function main() {
  console.log('Seeding database...');

  // Create or update demo shop
  const shop = await prisma.shop.upsert({
    where: { subdomain: 'demo' },
    update: {},
    create: {
      name: 'متجر ورود ديمو',
      subdomain: 'demo',
      username: 'demo_admin',
      password: hashPassword('demo123'),
      whatsappPhoneId: 'YOUR_WHATSAPP_PHONE_ID', // استبدله بمعرف رقم الواتساب الخاص بك
      whatsappToken: 'YOUR_WHATSAPP_ACCESS_TOKEN', // استبدله برمز الوصول الخاص بك
      whatsappVerifyToken: 'my_universal_token_123',
      stripeSecretKey: 'sk_test_your_key', // استبدله بمفتاح Stripe الخاص بك
      stripeWebhookSecret: 'whsec_your_webhook_secret',
      stripeSuccessUrl: 'https://demo.wardat.xyz/success',
      stripeCancelUrl: 'https://demo.wardat.xyz/cancel',
      whatsappAdminGroupId: 'YOUR_ADMIN_GROUP_ID', // اختياري: معرف جروب الإدارة للتبليغ
    },
  });

  console.log(`Demo shop created/verified: ${shop.name} (ID: ${shop.id})`);

  // Clear existing products of this shop to avoid duplication on re-run
  await prisma.product.deleteMany({
    where: { shopId: shop.id },
  });

  // Create products
  await prisma.product.createMany({
    data: [
      {
        shopId: shop.id,
        name: 'باقة ورد أحمر فاخرة',
        description: 'باقة من 24 وردة حمراء طبيعية مع تغليف أنيق',
        price: 199.0,
        imageUrl: 'https://example.com/images/red-roses.jpg',
        category: 'ورد',
        available: true,
      },
      {
        shopId: shop.id,
        name: 'باقة ورد مشكّلة',
        description: 'باقة مميزة من الورود المتنوعة بألوان زاهية',
        price: 149.0,
        imageUrl: 'https://example.com/images/mixed-bouquet.jpg',
        category: 'ورد',
        available: true,
      },
      {
        shopId: shop.id,
        name: 'صندوق ورد فاخر',
        description: 'صندوق مخملي فاخر مع ورود مرتبة بشكل احترافي',
        price: 299.0,
        imageUrl: 'https://example.com/images/luxury-box.jpg',
        category: 'صناديق',
        available: true,
      },
    ],
  });

  console.log('Demo products inserted.');
  console.log('Seeding finished successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
