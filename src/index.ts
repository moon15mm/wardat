import 'dotenv/config';
import express from 'express';
import { handleMessage } from './agents/agent-1-conversation';
import { handlePaymentSuccess, handlePaymentFailed } from './agents/agent-4-finance';
import { constructWebhookEvent } from './services/stripe-service';
import { markAsRead } from './services/whatsapp';
import { WhatsAppMessage } from './types';
import logger from './utils/logger';

const app = express();

// Stripe webhook needs raw body
app.post(
  '/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'] as string;

    try {
      const event = constructWebhookEvent(req.body, sig);
      logger.info(`[Stripe] Event: ${event.type}`);

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

// WhatsApp webhook verification
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('[WhatsApp] Webhook verified');
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

    const rawMessage = value.messages[0];
    const contact = value.contacts?.[0];

    const message: WhatsAppMessage = {
      from: rawMessage.from,
      type: rawMessage.type,
      text: rawMessage.text,
      location: rawMessage.location,
      image: rawMessage.image,
    };

    markAsRead(rawMessage.id);

    logger.info(
      `[WhatsApp] Message from ${message.from} (${contact?.profile?.name || 'unknown'}): ${message.text?.body || message.type}`
    );

    await handleMessage(message);

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
