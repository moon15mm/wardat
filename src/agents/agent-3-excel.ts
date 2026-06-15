import prisma from '../services/db';
import { Order } from '../types';
import logger from '../utils/logger';

export async function addOrder(order: Order): Promise<void> {
  try {
    await prisma.order.create({
      data: {
        id: order.id,
        shopId: order.shopId,
        timestamp: new Date(order.timestamp),
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        recipientName: order.recipientName,
        recipientPhone: order.recipientPhone,
        productName: order.product,
        price: order.price,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus || 'PENDING',
        locationUrl: order.locationUrl,
        fulfillmentType: order.fulfillmentType,
        preferredTime: order.preferredTime,
        stripeSessionId: order.stripeSessionId,
        cardLast4: order.cardLast4,
        productId: order.productId,
      },
    });
    logger.info(`[Database] Order ${order.id} added to PostgreSQL`);
  } catch (err: any) {
    logger.error(`[Database] Failed to add order: ${err.message}`);
    throw err;
  }
}

export async function updateOrderStatus(
  orderId: string,
  status: 'PENDING' | 'CONFIRMED' | 'FAILED',
  cardLast4?: string
): Promise<void> {
  try {
    await prisma.order.update({
      where: { id: orderId },
      data: {
        paymentStatus: status,
        cardLast4: cardLast4 ? `****${cardLast4}` : undefined,
      },
    });
    logger.info(`[Database] Order ${orderId} status updated to ${status}`);
  } catch (err: any) {
    logger.error(`[Database] Failed to update order status: ${err.message}`);
  }
}

export async function updateOrderPaymentSession(
  orderId: string,
  sessionId: string
): Promise<void> {
  try {
    await prisma.order.update({
      where: { id: orderId },
      data: { stripeSessionId: sessionId },
    });
    logger.info(`[Database] Payment session linked to order ${orderId}`);
  } catch (err: any) {
    logger.error(`[Database] Failed to update payment session: ${err.message}`);
  }
}

export async function addFinanceRecord(
  orderId: string,
  amount: number,
  customerName: string
): Promise<void> {
  // Financial records are queryable directly from the Orders table where status is CONFIRMED.
  // We keep this function to preserve backward compatibility.
  logger.info(`[Database] Finance record logged for order ${orderId} (Amount: ${amount})`);
}

export async function getOrderByStripeSession(
  sessionId: string
): Promise<{ orderId: string; phone: string; name: string } | null> {
  try {
    const order = await prisma.order.findFirst({
      where: { stripeSessionId: sessionId },
    });

    if (!order) return null;

    return {
      orderId: order.id,
      phone: order.customerPhone,
      name: order.customerName,
    };
  } catch (err: any) {
    logger.error(`[Database] Failed to query order by stripe session: ${err.message}`);
    return null;
  }
}
