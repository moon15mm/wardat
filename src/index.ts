import 'dotenv/config';
import dns from 'dns';
// Force IPv4 first to prevent Baileys/WhatsApp connection hanging on VPS with unrouted IPv6
dns.setDefaultResultOrder('ipv4first');
import express from 'express';
import path from 'path';
import apiRoutes from './routes/api';
import { handleMessage } from './agents/agent-1-conversation';
import { handlePaymentSuccess, handlePaymentFailed } from './agents/agent-4-finance';
import { constructWebhookEvent } from './services/stripe-service';
import { markAsRead, WhatsAppConfig } from './services/whatsapp';
import { WhatsAppMessage } from './types';
import prisma from './services/db';
import logger from './utils/logger';
import { initAllSessions } from './services/baileys-manager';
import cron from 'node-cron';

const app = express();

// Stripe webhook needs raw body
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;

    try {
      // Parse raw body to JSON to identify shopId and payment type before signature verification
      const payload = JSON.parse(req.body.toString());
      const shopId = payload.data?.object?.metadata?.shopId;
      const isPlatformRenewal = payload.data?.object?.metadata?.type === 'subscription_renewal';

      if (!shopId) {
        logger.error('[Stripe] Missing shopId in webhook metadata');
        res.status(400).send('Missing shopId in metadata');
        return;
      }

      let stripeConfig;

      if (isPlatformRenewal) {
        // Platform (Super Admin) keys for subscription payments
        stripeConfig = {
          secretKey: process.env.STRIPE_SECRET_KEY || '',
          webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
          successUrl: process.env.STRIPE_SUCCESS_URL || '',
          cancelUrl: process.env.STRIPE_CANCEL_URL || '',
        };
      } else {
        // Fetch the specific shop configuration from database for customer orders
        const shop = await prisma.shop.findUnique({
          where: { id: shopId },
        });

        if (!shop) {
          logger.error(`[Stripe] Shop with ID ${shopId} not found`);
          res.status(404).send('Shop not found');
          return;
        }

        stripeConfig = {
          secretKey: shop.stripeSecretKey || '',
          webhookSecret: shop.stripeWebhookSecret || '',
          successUrl: shop.stripeSuccessUrl || '',
          cancelUrl: shop.stripeCancelUrl || '',
        };
      }

      // Construct and verify event signature using correct webhook secret
      const event = constructWebhookEvent(stripeConfig, req.body, sig);
      logger.info(`[Stripe] Verified Event: ${event.type} (Platform Renewal: ${isPlatformRenewal})`);

      if (event.type === 'checkout.session.completed') {
        const sessionObj = event.data.object as any;
        if (isPlatformRenewal) {
          const { handleSubscriptionRenewalSuccess } = require('./agents/agent-4-finance');
          await handleSubscriptionRenewalSuccess(sessionObj);
        } else {
          await handlePaymentSuccess(sessionObj);
        }
      } else if (event.type === 'checkout.session.expired') {
        const sessionObj = event.data.object as any;
        if (!isPlatformRenewal) {
          await handlePaymentFailed(sessionObj);
        }
      }

      res.json({ received: true });
    } catch (err: any) {
      logger.error(`[Stripe] Webhook error: ${err.message}`);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

app.use(express.json());

// API routes
app.use('/api', apiRoutes);

// Static files serving
app.use(express.static(path.join(__dirname, '../public')));

// HTML redirects/routes for clean URLs
app.get('/superadmin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/superadmin/index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/success.html'));
});

app.get('/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/cancel.html'));
});

// Internal test simulator (remove before going fully public)
app.get('/test-simulator', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/test-simulator.html'));
});

// WhatsApp webhook verification (universal platform verification token)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('[WhatsApp] Universal webhook verified');
    res.status(200).send(challenge);
  } else {
    logger.warn('[WhatsApp] Webhook verification failed');
    res.sendStatus(403);
  }
});

// WhatsApp incoming messages
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') {
      res.sendStatus(404);
      return;
    }

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.[0]) {
      res.sendStatus(200);
      return;
    }

    // Identify target phone number ID to locate the tenant
    const targetPhoneId = value.metadata?.phone_number_id;
    if (!targetPhoneId) {
      logger.warn('[WhatsApp] Missing phone_number_id in incoming webhook metadata');
      res.sendStatus(200);
      return;
    }

    // Query tenant shop config
    const shop = await prisma.shop.findUnique({
      where: { whatsappPhoneId: targetPhoneId },
    });

    if (!shop) {
      logger.error(`[WhatsApp] Incoming message target Phone ID ${targetPhoneId} has no registered shop`);
      res.sendStatus(200);
      return;
    }

    const rawMessage = value.messages[0];
    const contact = value.contacts?.[0];

    const message: WhatsAppMessage = {
      from: rawMessage.from,
      type: rawMessage.type,
      text: rawMessage.text,
      location: rawMessage.location,
      image: rawMessage.image,
    };

    const whatsappConfig: WhatsAppConfig = {
      whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
      shopId: shop.id,
      token: shop.whatsappToken,
      phoneId: shop.whatsappPhoneId,
      adminGroupId: shop.whatsappAdminGroupId,
      ultramsgInstanceId: shop.ultramsgInstanceId,
      ultramsgToken: shop.ultramsgToken,
    };

    markAsRead(whatsappConfig, rawMessage.id);

    logger.info(
      `[WhatsApp] Message from ${message.from} (${contact?.profile?.name || 'unknown'}) to Shop ${shop.name}: ${message.text?.body || message.type}`
    );

    await handleMessage(message, shop.id);

    res.sendStatus(200);
  } catch (err: any) {
    logger.error(`[WhatsApp] Error processing message: ${err.message}`);
    res.sendStatus(200);
  }
});

// Helper to parse Ultramsg location messages
function parseUltramsgLocation(body: string): { latitude: number; longitude: number } | undefined {
  if (!body) return undefined;
  
  // Try to match standard "lat,lng" (e.g., "24.7136,46.6753")
  const commaMatch = body.match(/^(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
  if (commaMatch) {
    return {
      latitude: parseFloat(commaMatch[1]),
      longitude: parseFloat(commaMatch[2]),
    };
  }

  // Try to extract from Google Maps URL or query parameter q=lat,lng
  const urlMatch = body.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (urlMatch) {
    return {
      latitude: parseFloat(urlMatch[1]),
      longitude: parseFloat(urlMatch[2]),
    };
  }

  // Fallback pattern matching anywhere in the text
  const coordMatch = body.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  if (coordMatch) {
    return {
      latitude: parseFloat(coordMatch[1]),
      longitude: parseFloat(coordMatch[2]),
    };
  }

  return undefined;
}

// Ultramsg incoming messages (Standard WhatsApp)
app.post('/webhook/ultramsg', async (req, res) => {
  try {
    const body = req.body;
    const instanceId = body.instanceId;

    if (!instanceId || body.event_type !== 'message_received') {
      res.sendStatus(200);
      return;
    }

    const rawMsg = body.data;
    if (!rawMsg || rawMsg.fromMe === true) {
      res.sendStatus(200);
      return;
    }

    const shop = await prisma.shop.findFirst({
      where: {
        whatsappType: 'NORMAL',
        ultramsgInstanceId: instanceId,
      },
    });

    if (!shop) {
      logger.warn(`[Ultramsg] Incoming message target Instance ID ${instanceId} has no registered shop`);
      res.sendStatus(200);
      return;
    }

    // Clean number from "@c.us" or "@g.us"
    const fromPhone = rawMsg.from.split('@')[0];

    // Check if it is a location message or text
    const isLocation = rawMsg.type === 'location';
    const parsedLocation = isLocation || rawMsg.body?.includes('maps.google.com') ? parseUltramsgLocation(rawMsg.body) : undefined;

    const message: WhatsAppMessage = {
      from: fromPhone,
      type: parsedLocation ? 'location' : (rawMsg.type === 'chat' ? 'text' : rawMsg.type),
      text: rawMsg.type === 'chat' && !parsedLocation ? { body: rawMsg.body } : undefined,
      location: parsedLocation,
    };

    logger.info(
      `[Ultramsg] Message from ${message.from} to Shop ${shop.name}: ${rawMsg.body || rawMsg.type}`
    );

    await handleMessage(message, shop.id);

    res.sendStatus(200);
  } catch (err: any) {
    logger.error(`[Ultramsg] Error processing message: ${err.message}`);
    res.sendStatus(200);
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`WhatsApp webhook: /webhook/whatsapp`);
  logger.info(`Stripe webhook: /webhook/stripe`);
  
  await initAllSessions();

  // Daily Cron Job to expire shops past their subscription end date
  cron.schedule('0 0 * * *', async () => {
    logger.info('[Cron] Running daily subscription check...');
    try {
      const result = await prisma.shop.updateMany({
        where: {
          subscriptionStatus: 'ACTIVE',
          subscriptionEnd: {
            lt: new Date()
          }
        },
        data: {
          subscriptionStatus: 'EXPIRED'
        }
      });
      logger.info(`[Cron] Expired ${result.count} shops with ended subscriptions.`);
    } catch (err: any) {
      logger.error(`[Cron] Error checking subscriptions: ${err.message}`);
    }
  });
});
