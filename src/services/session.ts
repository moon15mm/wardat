import { Session, ConversationState, ChatMessage, Product } from '../types';
import prisma from './db';
import logger from '../utils/logger';
import { maskPhone } from '../utils/helpers';

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

export async function getSession(phone: string, shopId: string): Promise<Session> {
  const now = Date.now();
  
  let dbSession = await prisma.session.findUnique({
    where: {
      phone_shopId: { phone, shopId }
    }
  });

  if (dbSession && (now - Number(dbSession.lastActivity) > SESSION_TIMEOUT || dbSession.state === 'ARCHIVED')) {
    logger.info(`Session reset/unarchived for ${maskPhone(phone)} in shop ${shopId}`);
    dbSession = await prisma.session.update({
      where: { id: dbSession.id },
      data: {
        state: 'GREETING',
        orderData: JSON.stringify({}),
        selectedProductId: null,
        botPaused: false,
        lastActivity: BigInt(now)
      }
    });
  } else if (!dbSession) {
    dbSession = await prisma.session.create({
      data: {
        phone,
        shopId,
        state: 'GREETING',
        messages: JSON.stringify([]),
        lastActivity: BigInt(now),
        orderData: JSON.stringify({}),
      }
    });
    logger.info(`New session created for ${maskPhone(phone)} in shop ${shopId}`);
  } else {
    // Update last activity
    dbSession = await prisma.session.update({
      where: { id: dbSession.id },
      data: { lastActivity: BigInt(now) }
    });
  }

  let selectedProduct: Product | undefined = undefined;
  if (dbSession.selectedProductId) {
    const dbProduct = await prisma.product.findUnique({
      where: { id: dbSession.selectedProductId }
    });
    if (dbProduct) {
      selectedProduct = {
        id: dbProduct.id,
        name: dbProduct.name,
        description: dbProduct.description,
        price: dbProduct.price,
        imageUrl: dbProduct.imageUrl,
        category: dbProduct.category,
        available: dbProduct.available,
      };
    }
  }

  return {
    phone: dbSession.phone,
    state: dbSession.state as ConversationState,
    messages: JSON.parse(dbSession.messages),
    orderData: JSON.parse(dbSession.orderData),
    lastActivity: Number(dbSession.lastActivity),
    selectedProduct,
    botPaused: dbSession.botPaused,
  };
}

export async function updateSessionState(
  phone: string,
  shopId: string,
  state: ConversationState
): Promise<void> {
  await prisma.session.update({
    where: {
      phone_shopId: { phone, shopId }
    },
    data: { state }
  });
  logger.info(`Session ${maskPhone(phone)} in shop ${shopId} state updated to: ${state}`);
}

export async function addMessage(
  phone: string,
  shopId: string,
  message: ChatMessage
): Promise<void> {
  const session = await getSession(phone, shopId);
  session.messages.push(message);
  if (session.messages.length > 50) {
    session.messages = session.messages.slice(-30);
  }

  await prisma.session.update({
    where: {
      phone_shopId: { phone, shopId }
    },
    data: {
      messages: JSON.stringify(session.messages)
    }
  });
}

export async function updateSessionOrderData(
  phone: string,
  shopId: string,
  orderData: any,
  selectedProductId?: string
): Promise<void> {
  await prisma.session.update({
    where: {
      phone_shopId: { phone, shopId }
    },
    data: {
      orderData: JSON.stringify(orderData),
      selectedProductId: selectedProductId || null
    }
  });
}

export async function clearSession(phone: string, shopId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { phone, shopId },
    data: {
      state: 'ARCHIVED',
      orderData: JSON.stringify({}),
      selectedProductId: null,
      botPaused: false
    }
  });
  logger.info(`Session archived for ${maskPhone(phone)} in shop ${shopId}`);
}

export async function getActiveSessionCount(): Promise<number> {
  return await prisma.session.count();
}
