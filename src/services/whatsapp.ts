import axios from 'axios';
import logger from '../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export interface WhatsAppConfig {
  whatsappType: 'BUSINESS' | 'NORMAL';
  token: string | null;
  phoneId: string | null;
  adminGroupId?: string | null;
  ultramsgInstanceId?: string | null;
  ultramsgToken?: string | null;
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
      const instanceId = config.ultramsgInstanceId;
      const token = config.ultramsgToken;

      if (!instanceId || !token) {
        logger.error('[Ultramsg] Missing credentials to send message');
        return;
      }

      await axios.post(
        `https://api.ultramsg.com/${instanceId}/messages/chat`,
        {
          token,
          to,
          body: text,
        }
      );
      logger.info(`Ultramsg Message sent to ${to} (Instance ID: ${instanceId})`);
    } catch (err: any) {
      logger.error(`Failed to send Ultramsg message to ${to}: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
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
      const instanceId = config.ultramsgInstanceId;
      const token = config.ultramsgToken;

      if (!instanceId || !token) {
        logger.error('[Ultramsg] Missing credentials to send image');
        return;
      }

      await axios.post(
        `https://api.ultramsg.com/${instanceId}/messages/image`,
        {
          token,
          to,
          image: imageUrl,
          caption,
        }
      );
      logger.info(`Ultramsg Image sent to ${to} (Instance ID: ${instanceId})`);
    } catch (err: any) {
      logger.error(`Failed to send Ultramsg image to ${to}: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
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
