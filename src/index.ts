import 'dotenv/config';
import dns from 'dns';
// Force IPv4 first to prevent Baileys/WhatsApp connection hanging on VPS with unrouted IPv6
dns.setDefaultResultOrder('ipv4first');
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import apiRoutes from './routes/api';
import { handleMessage } from './agents/agent-1-conversation';
import { handlePaymentSuccess, handlePaymentFailed } from './agents/agent-4-finance';
import { constructWebhookEvent } from './services/stripe-service';
import { markAsRead, WhatsAppConfig } from './services/whatsapp';
import { WhatsAppMessage } from './types';
import prisma from './services/db';
import logger from './utils/logger';
import { initAllSessions } from './services/baileys-manager';
import { runSerialized, isDuplicate } from './utils/concurrency';
import * as settings from './services/settings';
import cron from 'node-cron';
import { runAcquisitionCycle } from './services/agent-acquisition';

// -------------------------------------------------------------
// Boot-time safety checks
// -------------------------------------------------------------
// auth.ts already throws if SESSION_SECRET is missing. Warn about other
// dangerous defaults so misconfiguration is loud, not silent.
if (!process.env.ADMIN_PASSWORD) {
  logger.warn('[Boot] ADMIN_PASSWORD is not set — Super Admin login is DISABLED until you set it.');
}
if (!process.env.WHATSAPP_APP_SECRET) {
  logger.warn('[Boot] WHATSAPP_APP_SECRET is not set — incoming WhatsApp webhook signatures will NOT be verified. Set it in production.');
}

const app = express();

// Trust the first proxy hop so rate-limiting and req.ip work behind nginx/Cloudflare.
app.set('trust proxy', 1);

// Security headers. CSP is disabled because the dashboards use inline scripts;
// enabling it would require refactoring the static HTML.
app.use(helmet({ contentSecurityPolicy: false }));

// -------------------------------------------------------------
// Rate limiters
// -------------------------------------------------------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'محاولات تسجيل دخول كثيرة جداً. يرجى المحاولة بعد 15 دقيقة.' },
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000, // generous: a single shop under load can send many messages
  standardHeaders: true,
  legacyHeaders: false,
});

// -------------------------------------------------------------
// Stripe webhook (needs raw body for signature verification)
// -------------------------------------------------------------
app.post(
  '/webhook/stripe',
  webhookLimiter,
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
        // Platform (Super Admin) keys for subscription payments (DB → env).
        stripeConfig = settings.getPlatformStripe();
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

      // Idempotency: ignore events we've already processed (Stripe retries on slow responses).
      if (isDuplicate(`stripe:${event.id}`)) {
        logger.info(`[Stripe] Duplicate event ${event.id} ignored`);
        res.json({ received: true });
        return;
      }

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

// Capture the raw body on all JSON requests so we can verify HMAC signatures.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

// Auth routes (login + password reset) are rate-limited to deter brute force.
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/forgot-password', loginLimiter);
app.use('/api/auth/reset-password', loginLimiter);
app.use('/api', apiRoutes);

// Static files serving. HTML is served with no-store so dashboard/cockpit
// updates are picked up immediately (no stale cached pages); other assets cache normally.
app.use(
  express.static(path.join(__dirname, '../public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate');
      }
    },
  })
);

// HTML redirects/routes for clean URLs
app.get('/superadmin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/superadmin/index.html'));
});

app.get('/superadmin/outreach', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/superadmin/outreach.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/login.html'));
});

app.get('/reset-password', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/reset-password.html'));
});

app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/success.html'));
});

app.get('/cancel', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/cancel.html'));
});

// Internal test simulator — only available outside production.
app.get('/test-simulator', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.sendStatus(404);
    return;
  }
  res.sendFile(path.join(__dirname, '../public/test-simulator.html'));
});

// -------------------------------------------------------------
// WhatsApp Cloud API signature verification (Meta)
// -------------------------------------------------------------
function verifyMetaSignature(req: express.Request): boolean {
  const appSecret = settings.getWhatsappAppSecret();
  if (!appSecret) {
    // Not configured: allow (migration window) but it was warned about at boot.
    return true;
  }

  const signature = req.headers['x-hub-signature-256'] as string | undefined;
  const rawBody = (req as any).rawBody as Buffer | undefined;
  if (!signature || !rawBody) return false;

  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, expBuf);
}

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
app.post('/webhook/whatsapp', webhookLimiter, async (req, res) => {
  // Reject forged requests before doing any work.
  if (!verifyMetaSignature(req)) {
    logger.warn('[WhatsApp] Rejected webhook with invalid signature');
    res.sendStatus(403);
    return;
  }

  // Acknowledge immediately so Meta does not retry while we process.
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.[0]) return;

    // Identify target phone number ID to locate the tenant
    const targetPhoneId = value.metadata?.phone_number_id;
    if (!targetPhoneId) {
      logger.warn('[WhatsApp] Missing phone_number_id in incoming webhook metadata');
      return;
    }

    const rawMessage = value.messages[0];

    // Drop duplicate deliveries by message id.
    if (isDuplicate(`wa:${rawMessage.id}`)) {
      logger.info(`[WhatsApp] Duplicate message ${rawMessage.id} ignored`);
      return;
    }

    // Query tenant shop config
    const shop = await prisma.shop.findUnique({
      where: { whatsappPhoneId: targetPhoneId },
    });

    if (!shop) {
      logger.error(`[WhatsApp] Incoming message target Phone ID ${targetPhoneId} has no registered shop`);
      return;
    }

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

    // Process one customer's messages strictly in order.
    await runSerialized(`${shop.id}:${message.from}`, () => handleMessage(message, shop.id));
  } catch (err: any) {
    logger.error(`[WhatsApp] Error processing message: ${err.message}`);
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
app.post('/webhook/ultramsg', webhookLimiter, async (req, res) => {
  // Optional shared-secret token check (set ULTRAMSG_WEBHOOK_TOKEN and append ?token=... to the webhook URL).
  const expectedToken = process.env.ULTRAMSG_WEBHOOK_TOKEN;
  if (expectedToken && req.query.token !== expectedToken) {
    logger.warn('[Ultramsg] Rejected webhook with invalid token');
    res.sendStatus(403);
    return;
  }

  // Acknowledge immediately.
  res.sendStatus(200);

  try {
    const body = req.body;
    const instanceId = body.instanceId;

    if (!instanceId || body.event_type !== 'message_received') return;

    const rawMsg = body.data;
    if (!rawMsg || rawMsg.fromMe === true) return;

    // Drop duplicate deliveries.
    if (rawMsg.id && isDuplicate(`um:${rawMsg.id}`)) {
      logger.info(`[Ultramsg] Duplicate message ${rawMsg.id} ignored`);
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

    await runSerialized(`${shop.id}:${message.from}`, () => handleMessage(message, shop.id));
  } catch (err: any) {
    logger.error(`[Ultramsg] Error processing message: ${err.message}`);
  }
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  logger.info(`Server running on port ${PORT}`);
  logger.info(`WhatsApp webhook: /webhook/whatsapp`);
  logger.info(`Stripe webhook: /webhook/stripe`);

  // Load DB-backed platform settings (plan prices, platform Stripe, app secret, SMTP).
  await settings.loadSettings();

  await initAllSessions();

  // Daily Cron Job to expire shops past their subscription end date
  cron.schedule('0 0 * * *', async () => {
    logger.info('[Cron] Running daily subscription check...');
    try {
      const result = await prisma.shop.updateMany({
        where: {
          subscriptionStatus: 'ACTIVE',
          subscriptionEnd: {
            lt: new Date(),
          },
        },
        data: {
          subscriptionStatus: 'EXPIRED',
        },
      });
      logger.info(`[Cron] Expired ${result.count} shops with ended subscriptions.`);
    } catch (err: any) {
      logger.error(`[Cron] Error checking subscriptions: ${err.message}`);
    }
  });

  // Daily Cron Job for the Customer Acquisition Agent (Runs at 1:00 AM)
  cron.schedule('0 1 * * *', async () => {
    logger.info('[Cron] Running daily Customer Acquisition Agent cycle...');
    try {
      await runAcquisitionCycle();
    } catch (err: any) {
      logger.error(`[Cron] Error running Customer Acquisition Agent cycle: ${err.message}`);
    }
  });

  // Acquisition agent: every 6 hours run a follow-up cycle when the agent is enabled.
  cron.schedule('0 */6 * * *', () => {
    if (settings.raw('AGENT_ENABLED') === 'true') {
      const { runCycle } = require('./services/acquisition-agent');
      runCycle().catch((e: any) => logger.error(`[Agent] scheduled cycle error: ${e.message}`));
    }
  });

  // Hourly Cron Job to purge stale sessions (older than 24h) so the table doesn't grow forever.
  cron.schedule('0 * * * *', async () => {
    try {
      const cutoff = BigInt(Date.now() - 24 * 60 * 60 * 1000);
      const result = await prisma.session.deleteMany({
        where: { lastActivity: { lt: cutoff } },
      });
      if (result.count > 0) {
        logger.info(`[Cron] Purged ${result.count} stale sessions.`);
      }
    } catch (err: any) {
      logger.error(`[Cron] Error purging stale sessions: ${err.message}`);
    }
  });
});

// -------------------------------------------------------------
// Graceful shutdown
// -------------------------------------------------------------
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Shutdown] Received ${signal}, closing server gracefully...`);

  server.close(async () => {
    try {
      await prisma.$disconnect();
    } catch (e) {
      // ignore
    }
    logger.info('[Shutdown] Closed cleanly.');
    process.exit(0);
  });

  // Force-exit if connections don't drain in time.
  setTimeout(() => {
    logger.warn('[Shutdown] Forced exit after timeout.');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
