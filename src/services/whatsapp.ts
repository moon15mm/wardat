import axios from 'axios';
import logger from '../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

export interface WhatsAppConfig {
  token: string;
  phoneId: string;
  adminGroupId?: string | null;
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
  try {
    await axios.post(
      `${GRAPH_API}/${config.phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      { headers: getHeaders(config.token) }
    );
    logger.info(`Message sent to ${to} (Phone ID: ${config.phoneId})`);
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
  try {
    await axios.post(
      `${GRAPH_API}/${config.phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, caption },
      },
      { headers: getHeaders(config.token) }
    );
    logger.info(`Image sent to ${to} (Phone ID: ${config.phoneId})`);
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
    logger.warn(`Admin group ID not configured for Phone ID ${config.phoneId}, skipping notification`);
    return;
  }
  try {
    await axios.post(
      `${GRAPH_API}/${config.phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: groupId,
        type: 'text',
        text: { body: message },
      },
      { headers: getHeaders(config.token) }
    );
    logger.info(`Admin group ${groupId} notified`);
  } catch (err: any) {
    logger.error(`Failed to notify admin group: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
  }
}

export function markAsRead(config: WhatsAppConfig, messageId: string): void {
  axios
    .post(
      `${GRAPH_API}/${config.phoneId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      { headers: getHeaders(config.token) }
    )
    .catch(() => {});
}
