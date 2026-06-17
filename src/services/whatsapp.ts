import axios from 'axios';
import logger from '../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export interface WhatsAppConfig {
  whatsappType: 'BUSINESS' | 'NORMAL';
  shopId?: string | null;
  token: string | null;
  phoneId: string | null;
  adminGroupId?: string | null;
  ultramsgInstanceId?: string | null; // Maintained for database compatibility
  ultramsgToken?: string | null;      // Maintained for database compatibility
}

function getHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function sendTextMessage(
  config: WhatsAppConfig,
  to: string,
  text: string
): Promise<void> {
  if (config.whatsappType === 'NORMAL') {
    try {
      const shopId = config.shopId;
      if (!shopId) {
        logger.error('[Baileys] Missing shopId in config to send message');
        return;
      }

      const { getSocket } = require('./baileys-manager');
      const sock = getSocket(shopId);

      if (!sock) {
        logger.error(`[Baileys] WhatsApp session not active for Shop ${shopId}. Message not sent.`);
        return;
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
      logger.info(`[Baileys] Message sent to ${to} for Shop ${shopId}`);
    } catch (err: any) {
      logger.error(`Failed to send Baileys message to ${to}: ${err.message}`);
      throw err;
    }
    return;
  }

  // BUSINESS (WhatsApp Cloud API)
  try {
    const token = config.token || '';
    const phoneId = config.phoneId || '';

    await axios.post(
      `${GRAPH_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      { headers: getHeaders(token) }
    );
    logger.info(`Message sent to ${to} (Phone ID: ${phoneId})`);
  } catch (err: any) {
    logger.error(`Failed to send message to ${to}: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
    throw err;
  }
}

export async function sendImageMessage(
  config: WhatsAppConfig,
  to: string,
  imageUrl: string,
  caption: string
): Promise<void> {
  if (config.whatsappType === 'NORMAL') {
    try {
      const shopId = config.shopId;
      if (!shopId) {
        logger.error('[Baileys] Missing shopId in config to send image');
        return;
      }

      const { getSocket } = require('./baileys-manager');
      const sock = getSocket(shopId);

      if (!sock) {
        logger.error(`[Baileys] WhatsApp session not active for Shop ${shopId}. Image not sent.`);
        return;
      }

      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(jid, { image: { url: imageUrl }, caption });
      logger.info(`[Baileys] Image sent to ${to} for Shop ${shopId}`);
    } catch (err: any) {
      logger.error(`Failed to send Baileys image to ${to}: ${err.message}`);
      throw err;
    }
    return;
  }

  // BUSINESS (WhatsApp Cloud API)
  try {
    const token = config.token || '';
    const phoneId = config.phoneId || '';

    await axios.post(
      `${GRAPH_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, caption },
      },
      { headers: getHeaders(token) }
    );
    logger.info(`Image sent to ${to} (Phone ID: ${phoneId})`);
  } catch (err: any) {
    logger.error(`Failed to send image to ${to}: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
    throw err;
  }
}

export async function sendLocationRequest(config: WhatsAppConfig, to: string): Promise<void> {
  await sendTextMessage(
    config,
    to,
    'يرجى مشاركة موقع التوصيل عبر واتساب.\n\nاضغط على 📎 ثم اختر "الموقع" وأرسل موقعك الحالي أو حدد عنوان التوصيل.'
  );
}

export async function sendToAdminGroup(config: WhatsAppConfig, message: string): Promise<void> {
  const groupId = config.adminGroupId;
  if (!groupId) {
    logger.warn(`Admin group ID not configured, skipping notification`);
    return;
  }

  if (config.whatsappType === 'NORMAL') {
    await sendTextMessage(config, groupId, message);
    return;
  }

  // BUSINESS (WhatsApp Cloud API)
  try {
    const token = config.token || '';
    const phoneId = config.phoneId || '';

    await axios.post(
      `${GRAPH_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: groupId,
        type: 'text',
        text: { body: message },
      },
      { headers: getHeaders(token) }
    );
    logger.info(`Admin group ${groupId} notified`);
  } catch (err: any) {
    logger.error(`Failed to notify admin group: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
  }
}

export async function forwardMediaToAdminGroup(
  config: WhatsAppConfig,
  mediaId: string,
  mediaType: 'image' | 'document',
  caption: string
): Promise<void> {
  const groupId = config.adminGroupId;
  if (!groupId) return;

  if (config.whatsappType === 'NORMAL') {
    await sendTextMessage(config, groupId, caption + '\n\n(عذراً، التوجيه التلقائي للملفات غير مدعوم في واتساب العادي. يرجى مراجعة المحادثة الأصلية.)');
    return;
  }

  // BUSINESS (WhatsApp Cloud API)
  try {
    const token = config.token || '';
    const phoneId = config.phoneId || '';

    const payload: any = {
      messaging_product: 'whatsapp',
      to: groupId,
      type: mediaType,
    };

    if (mediaType === 'image') {
      payload.image = { id: mediaId, caption };
    } else {
      payload.document = { id: mediaId, caption };
    }

    await axios.post(`${GRAPH_API}/${phoneId}/messages`, payload, { headers: getHeaders(token) });
    logger.info(`Media forwarded to admin group ${groupId}`);
  } catch (err: any) {
    logger.error(`Failed to forward media to admin group: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
    // Fallback to text message
    await sendToAdminGroup(config, caption + '\n\n(فشل توجيه الملف المرفق، يرجى مراجعة محادثة العميل الأصلية).');
  }
}

export function markAsRead(config: WhatsAppConfig, messageId: string): void {
  if (config.whatsappType === 'NORMAL') {
    return;
  }

  // BUSINESS (WhatsApp Cloud API)
  const token = config.token || '';
  const phoneId = config.phoneId || '';

  axios
    .post(
      `${GRAPH_API}/${phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      { headers: getHeaders(token) }
    )
    .catch(() => {});
}
