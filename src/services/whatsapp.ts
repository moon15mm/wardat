import axios from 'axios';
import logger from '../utils/logger';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function phoneNumberId() {
  return process.env.WHATSAPP_PHONE_NUMBER_ID!;
}

export async function sendTextMessage(to: string, text: string): Promise<void> {
  try {
    await axios.post(
      `${GRAPH_API}/${phoneNumberId()}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      },
      { headers: getHeaders() }
    );
    logger.info(`Message sent to ${to}`);
  } catch (err: any) {
    logger.error(`Failed to send message to ${to}: ${err.message}`);
    throw err;
  }
}

export async function sendImageMessage(
  to: string,
  imageUrl: string,
  caption: string
): Promise<void> {
  try {
    await axios.post(
      `${GRAPH_API}/${phoneNumberId()}/messages`,
      {
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { link: imageUrl, caption },
      },
      { headers: getHeaders() }
    );
    logger.info(`Image sent to ${to}`);
  } catch (err: any) {
    logger.error(`Failed to send image to ${to}: ${err.message}`);
    throw err;
  }
}

export async function sendLocationRequest(to: string): Promise<void> {
  await sendTextMessage(
    to,
    'يرجى مشاركة موقع التوصيل عبر واتساب.\n\nاضغط على 📎 ثم اختر "الموقع" وأرسل موقعك الحالي أو حدد عنوان التوصيل.'
  );
}

export async function sendToAdminGroup(message: string): Promise<void> {
  const groupId = process.env.WHATSAPP_ADMIN_GROUP_ID;
  if (!groupId) {
    logger.warn('WHATSAPP_ADMIN_GROUP_ID not set, skipping admin notification');
    return;
  }
  try {
    await axios.post(
      `${GRAPH_API}/${phoneNumberId()}/messages`,
      {
        messaging_product: 'whatsapp',
        to: groupId,
        type: 'text',
        text: { body: message },
      },
      { headers: getHeaders() }
    );
    logger.info('Admin group notified');
  } catch (err: any) {
    logger.error(`Failed to notify admin group: ${err.message}`);
  }
}

export function markAsRead(messageId: string): void {
  axios
    .post(
      `${GRAPH_API}/${phoneNumberId()}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      },
      { headers: getHeaders() }
    )
    .catch(() => {});
}
