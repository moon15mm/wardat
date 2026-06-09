import 'dotenv/config';
import express from 'express';
import path from 'path';
import apiRoutes from './routes/api';
import { handleMessage } from './agents/agent-1-conversation';
import { handlePaymentSuccess, handlePaymentFailed } from './agents/agent-4-finance';
import { constructWebhookEvent } from './services/stripe-service';
import { markAsRead } from './services/whatsapp';
import { WhatsAppMessage } from './types';
import prisma from './services/db';
import logger from './utils/logger';

const app = express();

// Stripe webhook needs raw body
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;

    try {
      // Parse raw body to JSON to identify shopId before signature verification
      const payload = JSON.parse(req.body.toString());
      const shopId = payload.data?.object?.metadata?.shopId;

      if (!shopId) {
        logger.error('[Stripe] Missing shopId in webhook metadata');
        res.status(400).send('Missing shopId in metadata');
        return;
      }

      // Fetch the specific shop configuration from database
      const shop = await prisma.shop.findUnique({
        where: { id: shopId },
      });

      if (!shop) {
        logger.error(`[Stripe] Shop with ID ${shopId} not found`);
        res.status(404).send('Shop not found');
        return;
      }

      const stripeConfig = {
        secretKey: shop.stripeSecretKey,
        webhookSecret: shop.stripeWebhookSecret,
        successUrl: shop.stripeSuccessUrl,
        cancelUrl: shop.stripeCancelUrl,
      };

      // Construct and verify event signature using shop-specific webhook secret
      const event = constructWebhookEvent(stripeConfig, req.body, sig);
      logger.info(`[Stripe] Verified Event: ${event.type} for shop: ${shop.name}`);

      if (event.type === 'checkout.session.completed') {
        await handlePaymentSuccess(event.data.object as any);
      } else if (event.type === 'checkout.session.expired') {
        await handlePaymentFailed(event.data.object as any);
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
app.use(apiRoutes);

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

    const whatsappConfig = {
      token: shop.whatsappToken,
      phoneId: shop.whatsappPhoneId,
      adminGroupId: shop.whatsappAdminGroupId,
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

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`WhatsApp webhook: /webhook/whatsapp`);
  logger.info(`Stripe webhook: /webhook/stripe`);
});
