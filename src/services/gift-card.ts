import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import logger from '../utils/logger';

// Escape user-supplied text before embedding it in SVG markup. Prevents tag/markup
// injection (e.g. an injected <image href="file://…"> that librsvg might load into
// the rendered PNG) and avoids breaking the SVG XML.
function escapeXml(s: string): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function generateGiftCardImage(senderNameRaw: string, messageRaw: string, shopNameRaw: string): Promise<string> {
  const width = 800;
  const height = 600;

  const senderName = escapeXml(senderNameRaw);
  const message = escapeXml(messageRaw);
  const shopName = escapeXml(shopNameRaw);

  // Basic SVG template for the gift card
  const svgText = `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#fdfbfb" />
          <stop offset="100%" stop-color="#ebedee" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bg)" rx="20" ry="20" />
      <text x="50%" y="25%" font-family="Arial, sans-serif" font-size="40" font-weight="bold" fill="#333" text-anchor="middle" direction="rtl">بطاقة إهداء من ${shopName}</text>
      
      <text x="50%" y="50%" font-family="Arial, sans-serif" font-size="36" fill="#555" text-anchor="middle" direction="rtl">${message}</text>
      
      <text x="50%" y="75%" font-family="Arial, sans-serif" font-size="28" font-style="italic" fill="#777" text-anchor="middle" direction="rtl">المرسل: ${senderName}</text>
    </svg>
  `;

  const buffer = Buffer.from(svgText);
  const uploadsDir = path.join(__dirname, '../../public/uploads/giftcards');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  const filename = `gift_${crypto.randomBytes(4).toString('hex')}.png`;
  const localPath = path.join(uploadsDir, filename);

  await sharp(buffer)
    .png()
    .toFile(localPath);

  logger.info(`[GiftCard] Generated gift card: ${filename}`);
  return `/uploads/giftcards/${filename}`;
}
