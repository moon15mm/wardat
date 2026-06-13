import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage, Browsers, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
const qrcode = require('qrcode');
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import prisma from './db';
import { handleMessage } from '../agents/agent-1-conversation';
import pino from 'pino';

// Active sockets map
export const activeSockets = new Map<string, any>();
// Latest QR code strings map
const latestQrCodes = new Map<string, string>();
// Connection statuses map
export const connectionStatuses = new Map<string, 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'QR_READY'>();
// Last errors map
export const lastErrors = new Map<string, any>();
// Pending reconnect timeouts
const reconnectTimeouts = new Map<string, NodeJS.Timeout>();

const sessionsDir = path.join(__dirname, '../../data/whatsapp-sessions');

if (!fs.existsSync(sessionsDir)) {
  fs.mkdirSync(sessionsDir, { recursive: true });
}

export async function initAllSessions(): Promise<void> {
  logger.info('[Baileys] Initializing active WhatsApp sessions...');
  try {
    const shops = await prisma.shop.findMany({
      where: {
        whatsappType: 'NORMAL',
        subscriptionStatus: 'ACTIVE',
      },
    });

    for (const shop of shops) {
      // Check if session directory has auth files already to reconnect
      const shopSessionPath = path.join(sessionsDir, shop.id);
      if (fs.existsSync(path.join(shopSessionPath, 'creds.json'))) {
        logger.info(`[Baileys] Autostarting WhatsApp session for shop: ${shop.name}`);
        startBaileysSession(shop.id).catch((err) => {
          logger.error(`[Baileys] Failed to autostart session for ${shop.name}: ${err.message}`);
        });
      }
    }
  } catch (err: any) {
    logger.error(`[Baileys] Error in initAllSessions: ${err.message}`);
  }
}

export async function startBaileysSession(shopId: string): Promise<void> {
  if (activeSockets.has(shopId)) {
    return;
  }

  connectionStatuses.set(shopId, 'CONNECTING');
  logger.info(`[Baileys] Starting session for Shop: ${shopId}`);

  try {
    const shopSessionPath = path.join(sessionsDir, shopId);
    if (!fs.existsSync(shopSessionPath)) {
      fs.mkdirSync(shopSessionPath, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(shopSessionPath);
    
    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
      logger.info(`[Baileys] Using WA v${version.join('.')}`);
    } catch (verErr) {
      logger.warn(`[Baileys] Failed to fetch latest version, using fallback: ${verErr}`);
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'warn' }) as any,
      browser: Browsers.macOS('Desktop'),
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    activeSockets.set(shopId, sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQrCodes.set(shopId, qr);
      connectionStatuses.set(shopId, 'QR_READY');
      logger.info(`[Baileys] QR Code ready for Shop: ${shopId}`);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      logger.warn(`[Baileys] Connection closed for ${shopId}. Reason: ${lastDisconnect?.error}. Reconnecting: ${shouldReconnect}`);
      lastErrors.set(shopId, lastDisconnect?.error?.message || lastDisconnect?.error?.toString());
      
      activeSockets.delete(shopId);
      latestQrCodes.delete(shopId);

      if (shouldReconnect) {
        logger.info(`[Baileys] Scheduling reconnection in 10 seconds for Shop: ${shopId}...`);
        const tid = setTimeout(() => {
          reconnectTimeouts.delete(shopId);
          startBaileysSession(shopId).catch((err) => {
            logger.error(`[Baileys] Reconnection failed for Shop ${shopId}: ${err.message}`);
          });
        }, 10000);
        reconnectTimeouts.set(shopId, tid);
      } else {
        connectionStatuses.set(shopId, 'DISCONNECTED');
        // Logged out: clean session folder
        try {
          fs.rmSync(shopSessionPath, { recursive: true, force: true });
        } catch (e) {
          logger.error(`[Baileys] Error deleting folder for ${shopId}: ${e}`);
        }
      }
    } else if (connection === 'open') {
      connectionStatuses.set(shopId, 'CONNECTED');
      latestQrCodes.delete(shopId);
      logger.info(`[Baileys] Connection opened successfully for Shop: ${shopId}`);
      try {
        await prisma.shop.update({
          where: { id: shopId },
          data: { whatsappType: 'NORMAL' },
        });
        logger.info(`[Baileys] Automatically updated shop ${shopId} whatsappType to NORMAL in database`);
      } catch (dbErr: any) {
        logger.error(`[Baileys] Failed to auto-update shop whatsappType to NORMAL: ${dbErr.message}`);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type === 'notify') {
      for (const msg of m.messages) {
        // Only process messages from others, with message payload
        if (!msg.key.fromMe && msg.message) {
          const fromJid = msg.key.remoteJid;
          if (!fromJid) continue;

          // Ignore group messages
          if (fromJid.endsWith('@g.us')) {
            continue;
          }

          // Unwrap nested message types (ephemeral, view once, etc.)
          let rawMsg = msg.message;
          if (rawMsg.ephemeralMessage?.message) {
            rawMsg = rawMsg.ephemeralMessage.message;
          }
          if (rawMsg.viewOnceMessage?.message) {
            rawMsg = rawMsg.viewOnceMessage.message;
          }
          if (rawMsg.viewOnceMessageV2?.message) {
            rawMsg = rawMsg.viewOnceMessageV2.message;
          }

          // WhatsApp/Baileys v7 may address users by a privacy LID (e.g. "<id>@lid")
          // instead of "<number>@s.whatsapp.net". We must REPLY to the exact JID we
          // received from — reconstructing "<id>@s.whatsapp.net" from a LID sends to a
          // non-existent address (the customer never gets a reply). So keep the full
          // JID for LID senders, and the clean number for normal senders.
          const from = fromJid.endsWith('@lid') ? fromJid : fromJid.split('@')[0];
          const text = rawMsg.conversation || rawMsg.extendedTextMessage?.text || rawMsg.imageMessage?.caption || '';
          const isLocation = !!rawMsg.locationMessage;
          const isImage = !!rawMsg.imageMessage;

          let imageBuffer: Buffer | undefined;
          let mimeType = '';
          if (isImage) {
            try {
              imageBuffer = await downloadMediaMessage(
                msg,
                'buffer',
                { },
                { 
                  logger: pino({ level: 'silent' }) as any,
                  reuploadRequest: sock.updateMediaMessage
                }
              ) as Buffer;
              mimeType = rawMsg.imageMessage?.mimetype || 'image/jpeg';
            } catch (err: any) {
              logger.error(`[Baileys] Failed to download image from ${from}: ${err.message}`);
            }
          }

          // Structure WhatsAppMessage
          const formattedMsg: any = {
            from,
            type: isImage ? 'image' : (isLocation ? 'location' : 'text'),
            text: text ? { body: text } : undefined,
            location: isLocation ? {
              latitude: rawMsg.locationMessage?.degreesLatitude,
              longitude: rawMsg.locationMessage?.degreesLongitude,
            } : undefined,
            image: (isImage && imageBuffer) ? {
              mime_type: mimeType,
              buffer: imageBuffer,
              caption: text
            } : undefined
          };

          logger.info(`[Baileys] Message from ${from} for shop ${shopId}: ${text || (isLocation ? 'Location' : 'Other')}`);
          
          try {
            await handleMessage(formattedMsg, shopId);
          } catch (err: any) {
            logger.error(`[Baileys] Error in handleMessage for shop ${shopId}: ${err.message}`);
          }
        }
      }
    }
  });
  } catch (err: any) {
    logger.error(`[Baileys] Error starting session for shop ${shopId}: ${err.message}`);
    connectionStatuses.set(shopId, 'DISCONNECTED');
    activeSockets.delete(shopId);
    throw err;
  }
}

export function getSocket(shopId: string): any {
  return activeSockets.get(shopId);
}

export function getSessionStatus(shopId: string): { status: string; qr?: string } {
  const status = connectionStatuses.get(shopId) || 'DISCONNECTED';
  const qrString = latestQrCodes.get(shopId);
  return { status, qr: qrString };
}

export async function generateQrCodeImage(qrString: string): Promise<string> {
  return await qrcode.toDataURL(qrString);
}

export async function logoutSession(shopId: string): Promise<void> {
  const tid = reconnectTimeouts.get(shopId);
  if (tid) {
    clearTimeout(tid);
    reconnectTimeouts.delete(shopId);
  }

  const sock = activeSockets.get(shopId);
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {}
    try {
      sock.end();
    } catch (e) {}
  }
  activeSockets.delete(shopId);
  latestQrCodes.delete(shopId);
  connectionStatuses.set(shopId, 'DISCONNECTED');

  const shopSessionPath = path.join(sessionsDir, shopId);
  
  if (fs.existsSync(shopSessionPath)) {
    try {
      // Instantly rename the folder to avoid race conditions if the user immediately starts a new session
      const trashPath = shopSessionPath + '_trash_' + Date.now();
      fs.renameSync(shopSessionPath, trashPath);
      logger.info(`[Baileys] Session folder moved to trash for Shop: ${shopId}`);
      
      // Asynchronously delete the trash folder
      setTimeout(() => {
        try {
          fs.rmSync(trashPath, { recursive: true, force: true });
        } catch (err) {}
      }, 5000);
    } catch (e) {
      logger.error(`[Baileys] Error moving session folder to trash for ${shopId}: ${e}`);
      try {
        fs.rmSync(shopSessionPath, { recursive: true, force: true });
      } catch (err) {}
    }
  }
}

export async function postWhatsAppStatus(shopId: string, product: any): Promise<number> {
  const sock = activeSockets.get(shopId);
  if (!sock) {
    throw new Error('جلسة الواتساب غير نشطة أو غير متصلة.');
  }

  // Fetch unique customer phones from sessions
  const sessions = await prisma.session.findMany({
    where: { shopId },
    select: { phone: true }
  });

  if (sessions.length === 0) {
    throw new Error('لا يوجد عملاء سابقين لنشر الحالة لهم.');
  }

  // Baileys needs JIDs for status viewers
  let jidList = sessions.map(s => {
    let phone = s.phone.replace(/\D/g, '');
    if (!phone.includes('@')) phone = `${phone}@s.whatsapp.net`;
    return phone;
  });

  // Always include the sender's own JID so the status appears in "My Status" on their phone
  if (sock.user && sock.user.id) {
    const senderJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    jidList.push(senderJid);
  }

  // Remove duplicates
  jidList = [...new Set(jidList)];

  const caption = `🌹 *${product.name}*\n💰 السعر: ${product.price} ريال\n\nلطلب المنتج، أرسل اسمه في رسالة خاصة 🛒`;
  
  let content: any = { 
    text: caption,
    backgroundColor: 4286260415, // ARGB format for #7b2cbf (0xFF7B2CBF)
    font: 1 
  };

  if (product.imageUrl) {
    let imageBuffer: Buffer | null = null;
    try {
      if (product.imageUrl.startsWith('/uploads')) {
        const localPath = path.join(__dirname, '../../public', product.imageUrl);
        if (fs.existsSync(localPath)) {
          imageBuffer = fs.readFileSync(localPath);
        }
      } else if (product.imageUrl.startsWith('http')) {
        const axios = require('axios');
        const res = await axios.get(product.imageUrl, { responseType: 'arraybuffer' });
        imageBuffer = Buffer.from(res.data);
      }

      if (imageBuffer) {
        content = {
          image: imageBuffer,
          caption
        };
      }
    } catch (e) {
      logger.error(`[Baileys Status] Failed to load image for product ${product.id}: ${e}`);
    }
  }

  await sock.sendMessage('status@broadcast', content, {
    statusJidList: jidList,
    broadcast: true
  });

  logger.info(`[Baileys Status] Status posted successfully for Shop: ${shopId}. Sent to ${jidList.length} contacts.`);
  return jidList.length;
}
