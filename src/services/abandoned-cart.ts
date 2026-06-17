import prisma from './db';
import { sendTextMessage } from './whatsapp';
import logger from '../utils/logger';

export function startAbandonedCartJob() {
  // Run every 5 minutes
  setInterval(async () => {
    try {
      const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
      // Find all sessions that are not completed and haven't had a recovery sent
      // but are older than 30 minutes
      const abandonedSessions = await prisma.session.findMany({
        where: {
          lastActivity: { lt: thirtyMinutesAgo },
          recoverySent: false,
          botPaused: false,
          state: {
            notIn: ['COMPLETED', 'AWAITING_PAYMENT', 'GREETING'],
          },
        },
        include: { shop: true },
      });

      for (const session of abandonedSessions) {
        let orderData: any = {};
        try {
          orderData = JSON.parse(session.orderData);
        } catch (e) {}

        const customerName = orderData.customerName || 'عزيزي العميل';
        
        const message = `مرحباً ${customerName}، 👋\n\nلاحظنا أنك ما زلت في منتصف إتمام طلبك من *${session.shop.name}*. هل واجهت أي مشكلة أو تحتاج إلى مساعدة؟\n\nنحن هنا لخدمتك، ويمكنك المتابعة بمجرد إرسال أي رسالة! 🌹`;

        const whatsappConfig = {
          whatsappType: session.shop.whatsappType as 'BUSINESS' | 'NORMAL',
          shopId: session.shop.id,
          token: session.shop.whatsappToken,
          phoneId: session.shop.whatsappPhoneId,
        };

        try {
          await sendTextMessage(whatsappConfig, session.phone, message);
          
          // Mark as sent
          await prisma.session.update({
            where: { id: session.id },
            data: { recoverySent: true },
          });

          logger.info(`[AbandonedCart] Sent recovery message to ${session.phone} for shop ${session.shopId}`);
          
          // Slight delay between messages to prevent rate-limiting if there are many
          await new Promise(res => setTimeout(res, 2000));
        } catch (err: any) {
          logger.error(`[AbandonedCart] Failed to send to ${session.phone}: ${err.message}`);
        }
      }
    } catch (err: any) {
      logger.error(`[AbandonedCart] Job error: ${err.message}`);
    }
  }, 5 * 60 * 1000); // 5 minutes
}
