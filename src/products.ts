import prisma from './services/db';
import { Product } from './types';

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

  // Send intro message
  const introMsg = '🛍️ *مرحباً! إليك منتجاتنا المتاحة:*';
  await sendTextFn(whatsappConfig, phone, introMsg);

  // Send each product as an image card
  for (let i = 0; i < available.length; i++) {
    const p = available[i];
    const stockText = (p.stock !== undefined && p.stock <= 3 && p.stock > 0) 
      ? `\n🔥 _متبقي ${p.stock} فقط - اطلب الآن!_` 
      : '';
    const outOfStock = (p.stock !== undefined && p.stock <= 0) 
      ? '\n❌ _نفدت الكمية حالياً_' 
      : '';
    
    const caption = `*${i + 1}. ${p.name}* 🌹\n` +
      `━━━━━━━━━━━━━━\n` +
      (p.description ? `📝 ${p.description}\n\n` : '\n') +
      `💰 *السعر: ${p.price} ريال*${stockText}${outOfStock}\n\n` +
      `📩 _أرسل الرقم *${i + 1}* لطلب هذا المنتج_`;

    if (p.imageUrl && p.imageUrl.trim() !== '') {
      try {
        await sendImageFn(whatsappConfig, phone, p.imageUrl, caption);
      } catch (err) {
        // Fallback to text if image fails
        await sendTextFn(whatsappConfig, phone, caption);
      }
    } else {
      await sendTextFn(whatsappConfig, phone, caption);
    }

    // Small delay between messages to avoid rate limiting
    if (i < available.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }

  // Send summary selection message
  const summaryParts = available.map((p, i) => `*${i + 1}*- ${p.name}`);
  const summaryMsg = `━━━━━━━━━━━━━━━━━━━\n` +
    `📋 *ملخص المنتجات:*\n\n` +
    summaryParts.join('\n') + 
    `\n\n✅ *أرسل رقم المنتج* الذي يعجبك للطلب!`;
  
  await sendTextFn(whatsappConfig, phone, summaryMsg);
  
  return `عرض كتالوج المنتجات (${available.length} منتج)`;
}

export default getAllProducts;
