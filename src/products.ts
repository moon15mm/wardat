import prisma from './services/db';
import { Product } from './types';
import { buildCatalogCollage } from './services/catalog-image';

export async function getAllProducts(shopId: string): Promise<Product[]> {
  const dbProducts = await prisma.product.findMany({
    where: { shopId, available: true },
  });
  return dbProducts.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: p.imageUrl,
    category: p.category,
    available: p.available,
  }));
}

export async function getProductById(shopId: string, id: string): Promise<Product | null> {
  const p = await prisma.product.findFirst({
    where: { id, shopId, available: true },
  });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: p.imageUrl,
    category: p.category,
    available: p.available,
  };
}

export async function getProductByName(shopId: string, name: string): Promise<Product | null> {
  const p = await prisma.product.findFirst({
    where: {
      shopId,
      available: true,
      OR: [
        { name: { contains: name } },
        { id: { contains: name.toLowerCase() } },
      ],
    },
  });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: p.imageUrl,
    category: p.category,
    available: p.available,
  };
}

export async function formatProductList(shopId: string): Promise<string> {
  const available = await getAllProducts(shopId);
  if (available.length === 0) {
    return 'لا توجد منتجات متوفرة حالياً في هذا المتجر.';
  }
  let list = '🛍️ *قائمة منتجاتنا المتوفرة* 🛍️\n';
  list += '━━━━━━━━━━━━━━━━━━━\n\n';
  available.forEach((p, i) => {
    const stockEmoji = (p.stock !== undefined && p.stock <= 3) ? ' 🔥 _كمية محدودة!_' : '';
    list += `*${i + 1}.* 🌹 *${p.name}*\n`;
    if (p.description) {
      list += `     📝 ${p.description}\n`;
    }
    list += `     💰 *${p.price} ريال*${stockEmoji}\n\n`;
  });
  list += '━━━━━━━━━━━━━━━━━━━\n';
  list += '✅ *اختر رقم المنتج* أو اكتب اسمه للطلب';
  return list;
}

// Send products as rich image cards in WhatsApp
export async function sendProductCatalog(
  shopId: string,
  whatsappConfig: any,
  phone: string,
  sendTextFn: (config: any, to: string, text: string) => Promise<void>,
  sendImageFn: (config: any, to: string, imageUrl: string, caption: string) => Promise<void>,
): Promise<string> {
  const available = await getAllProducts(shopId);

  if (available.length === 0) {
    const msg = 'لا توجد منتجات متوفرة حالياً في هذا المتجر.';
    await sendTextFn(whatsappConfig, phone, msg);
    return msg;
  }

  // Build a single collage image (grid of all products with number badges).
  let collageUrl: string | null = null;
  try {
    collageUrl = await buildCatalogCollage(shopId, available);
  } catch {
    collageUrl = null;
  }

  // Build the accompanying numbered text list (names, prices, stock hints).
  let list = '🛍️ *قائمة منتجاتنا المتوفرة* 🛍️\n━━━━━━━━━━━━━━━━━━━\n\n';
  available.forEach((p, i) => {
    const stockText = (p.stock !== undefined && p.stock <= 3 && p.stock > 0)
      ? ` 🔥 _متبقّي ${p.stock} فقط_`
      : (p.stock !== undefined && p.stock <= 0 ? ' ❌ _نفدت الكمية_' : '');
    list += `*${i + 1}.* 🌹 *${p.name}* — *${p.price} ريال*${stockText}\n`;
    if (p.description) list += `     📝 ${p.description}\n`;
    list += `\n`;
  });
  list += '━━━━━━━━━━━━━━━━━━━\n✅ *أرسل رقم المنتج* الذي يعجبك لطلبه مباشرة';

  // Send: one image (collage) then one text list. Falls back to text-only.
  if (collageUrl) {
    try {
      await sendImageFn(whatsappConfig, phone, collageUrl, '🛍️ *إليك منتجاتنا المتوفرة* 👇');
    } catch {
      /* image failed — the text list below still carries everything */
    }
  }
  await sendTextFn(whatsappConfig, phone, list);

  return `عرض كتالوج المنتجات (${available.length} منتج)`;
}

export default getAllProducts;
