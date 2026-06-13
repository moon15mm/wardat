import sharp from 'sharp';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger';
import * as settings from './settings';
import { Product } from '../types';

/**
 * Builds a single grid "collage" image of all products, each with a number badge,
 * so the WhatsApp catalog can be shown in ONE image + one text list instead of
 * many separate image messages.
 *
 * Product names/prices are NOT drawn on the image (Arabic text shaping on canvas
 * is unreliable) — they go in the accompanying text list, keyed by the same number.
 */

const CATALOG_DIR = path.join(__dirname, '../../public/catalogs');
const CELL = 500;
const GAP = 12;
const BADGE = 76;

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 10000 });
    return Buffer.from(r.data);
  } catch {
    return null;
  }
}

function badgeSvg(n: number): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${BADGE}" height="${BADGE}">` +
      `<circle cx="${BADGE / 2}" cy="${BADGE / 2}" r="${BADGE / 2 - 4}" fill="#ff2d81" stroke="white" stroke-width="5"/>` +
      `<text x="${BADGE / 2}" y="${BADGE / 2 + 15}" font-size="42" fill="white" text-anchor="middle" font-family="Arial, sans-serif" font-weight="bold">${n}</text>` +
      `</svg>`
  );
}

async function buildCell(product: Product, index: number): Promise<Buffer> {
  let base: Buffer | null = null;
  if (product.imageUrl && product.imageUrl.trim()) {
    const urlOrPath = product.imageUrl.trim();
    let buf: Buffer | null = null;
    
    try {
      if (urlOrPath.startsWith('/uploads/')) {
        // Local file
        const localPath = path.join(__dirname, '../../public', urlOrPath);
        if (fs.existsSync(localPath)) {
          buf = fs.readFileSync(localPath);
        }
      } else if (urlOrPath.startsWith('http')) {
        // External URL
        buf = await fetchImage(urlOrPath);
      }
    } catch (e) {
      logger.error(`[Catalog] Error reading image ${urlOrPath}: ${e}`);
    }

    if (buf) {
      try {
        base = await sharp(buf).resize(CELL, CELL, { fit: 'cover' }).toBuffer();
      } catch {
        base = null;
      }
    }
  }
  if (!base) {
    // Placeholder cell (brand-dark) for products without a usable image.
    base = await sharp({
      create: { width: CELL, height: CELL, channels: 3, background: { r: 38, g: 30, b: 56 } },
    })
      .png()
      .toBuffer();
  }
  return sharp(base)
    .composite([{ input: badgeSvg(index + 1), top: 16, left: CELL - BADGE - 16 }])
    .jpeg({ quality: 82 })
    .toBuffer();
}

/**
 * Returns the public URL of the generated collage (cached by content hash), or
 * null if no products. Falls back to null on failure so the caller can degrade.
 */
export async function buildCatalogCollage(shopId: string, products: Product[]): Promise<string | null> {
  if (!products.length) return null;

  const key = products.map((p) => `${p.id}|${p.imageUrl || ''}`).join(',');
  const hash = crypto.createHash('md5').update(key).digest('hex').slice(0, 10);
  if (!fs.existsSync(CATALOG_DIR)) fs.mkdirSync(CATALOG_DIR, { recursive: true });

  const fileName = `${shopId}-${hash}.jpg`;
  const filePath = path.join(CATALOG_DIR, fileName);
  const url = `${settings.getAppBaseUrl()}/catalogs/${fileName}`;

  if (fs.existsSync(filePath)) return url; // cached for this exact product set

  try {
    const cols = products.length === 1 ? 1 : 2;
    const rows = Math.ceil(products.length / cols);
    const W = cols * CELL + (cols + 1) * GAP;
    const H = rows * CELL + (rows + 1) * GAP;

    const cells = await Promise.all(products.map((p, i) => buildCell(p, i)));
    const composites = cells.map((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return { input: c, top: GAP + row * (CELL + GAP), left: GAP + col * (CELL + GAP) };
    });

    await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite(composites)
      .jpeg({ quality: 84 })
      .toFile(filePath);

    logger.info(`[Catalog] Built collage for shop ${shopId}: ${fileName}`);
    return url;
  } catch (err: any) {
    logger.error(`[Catalog] Collage build failed for shop ${shopId}: ${err.message}`);
    return null;
  }
}
