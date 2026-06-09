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
  let list = 'منتجاتنا المتوفرة:\n\n';
  available.forEach((p, i) => {
    list += `${i + 1}. ${p.name}\n`;
    list += `   ${p.description}\n`;
    list += `   السعر: ${p.price} ريال\n\n`;
  });
  list += 'اختر رقم المنتج أو اكتب اسمه';
  return list;
}

export default getAllProducts;
