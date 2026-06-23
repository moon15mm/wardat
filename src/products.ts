import prisma from './services/db';
import { Product } from './types';
import { buildCatalogCollage } from './services/catalog-image';

export async function getAllProducts(shopId: string): Promise<Product[]> {
  const dbProducts = await prisma.product.findMany({
    where: { shopId, available: true, stock: { gt: 0 } },
    orderBy: { id: 'asc' },
  });
  return dbProducts.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price: p.price,
    imageUrl: p.imageUrl,
    category: p.category,
    available: p.available,
    stock: p.stock,
  }));
}

export async function getProductById(shopId: string, id: string): Promise<Product | null> {
  const p = await prisma.product.findFirst({
    where: { id, shopId, available: true, stock: { gt: 0 } },
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
    stock: p.stock,
  };
}

export async function getProductByName(shopId: string, name: string): Promise<Product | null> {
  const products = await getAllProducts(shopId);
  const searchWords = name.trim().toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (searchWords.length === 0) {
    // If name is too short or empty, try exact match just in case
    return products.find(p => p.name.toLowerCase() === name.trim().toLowerCase()) || null;
  }
  
  let bestMatch = null;
  let maxScore = 0;
  
  for (const p of products) {
    const pName = p.name.toLowerCase();
    let score = 0;
    // Exact match is an automatic win
    if (pName === name.trim().toLowerCase()) return p;
    
    for (const w of searchWords) {
      if (pName.includes(w)) score++;
    }
    if (score > maxScore) {
      maxScore = score;
      bestMatch = p;
    }
  }
  
  // Require at least half the words to match to avoid wild guesses
  const threshold = Math.max(1, Math.floor(searchWords.length / 2));
  return maxScore >= threshold ? bestMatch : null;
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
