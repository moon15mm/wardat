import { Product } from './types';

const products: Product[] = [
  {
    id: 'bouquet-red-roses',
    name: 'باقة ورد أحمر فاخرة',
    description: 'باقة من 24 وردة حمراء طبيعية مع تغليف أنيق',
    price: 199,
    imageUrl: 'https://example.com/images/red-roses.jpg',
    category: 'ورد',
    available: true,
  },
  {
    id: 'bouquet-mixed',
    name: 'باقة ورد مشكّلة',
    description: 'باقة مميزة من الورود المتنوعة بألوان زاهية',
    price: 149,
    imageUrl: 'https://example.com/images/mixed-bouquet.jpg',
    category: 'ورد',
    available: true,
  },
  {
    id: 'bouquet-white',
    name: 'باقة ورد أبيض',
    description: 'باقة أنيقة من الورود البيضاء مع أوراق خضراء',
    price: 179,
    imageUrl: 'https://example.com/images/white-roses.jpg',
    category: 'ورد',
    available: true,
  },
  {
    id: 'box-luxury',
    name: 'صندوق ورد فاخر',
    description: 'صندوق مخملي فاخر مع ورود مرتبة بشكل احترافي',
    price: 299,
    imageUrl: 'https://example.com/images/luxury-box.jpg',
    category: 'صناديق',
    available: true,
  },
  {
    id: 'box-chocolate',
    name: 'صندوق ورد وشوكولاتة',
    description: 'صندوق يجمع بين الورود الجميلة والشوكولاتة الفاخرة',
    price: 349,
    imageUrl: 'https://example.com/images/choco-box.jpg',
    category: 'صناديق',
    available: true,
  },
];

export function getAllProducts(): Product[] {
  return products.filter((p) => p.available);
}

export function getProductById(id: string): Product | undefined {
  return products.find((p) => p.id === id && p.available);
}

export function getProductByName(name: string): Product | undefined {
  const lower = name.toLowerCase();
  return products.find(
    (p) => p.available && (p.name.includes(name) || p.id.includes(lower))
  );
}

export function formatProductList(): string {
  const available = getAllProducts();
  let list = 'منتجاتنا المتوفرة:\n\n';
  available.forEach((p, i) => {
    list += `${i + 1}. ${p.name}\n`;
    list += `   ${p.description}\n`;
    list += `   السعر: ${p.price} ريال\n\n`;
  });
  list += 'اختر رقم المنتج أو اكتب اسمه';
  return list;
}

export default products;
