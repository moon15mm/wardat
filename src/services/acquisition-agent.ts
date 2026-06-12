import axios from 'axios';
import prisma from './db';
import logger from '../utils/logger';
import * as settings from './settings';
import { generateOutreachDrafts } from './outreach';
import { sendTextMessage, WhatsAppConfig } from './whatsapp';

/**
 * Acquisition Agent — helps land the first paying subscriber.
 *
 * Responsibly scoped:
 * - Lead discovery uses the real Google Places API (requires GOOGLE_PLACES_API_KEY).
 *   It NEVER fabricates businesses or phone numbers.
 * - The autonomous cycle only sends FOLLOW-UPS to prospects already contacted
 *   (status CONTACTED/INTERESTED/DEMO that went stale) — never cold-blasts freshly
 *   discovered numbers. First contact stays a manual, reviewed action.
 * - Sending is rate-limited and capped per cycle to reduce WhatsApp ban risk.
 */

const MAX_LOGS = 250;
const logs: string[] = [];
let running = false;

function ts(): string {
  return new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
}

export function agentLog(line: string): void {
  logs.push(`[${ts()}] ${line}`);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}
export function getLogs(): string[] {
  return logs;
}
export function clearLogs(): void {
  logs.length = 0;
}

export interface AgentSettings {
  enabled: boolean;
  city: string;
  senderShopId: string;
  followupDays: number;
  autoSend: boolean;
}

export function getAgentSettings(): AgentSettings {
  return {
    enabled: settings.raw('AGENT_ENABLED') === 'true',
    city: settings.raw('AGENT_CITY') || '',
    senderShopId: settings.raw('AGENT_SENDER_SHOP_ID') || '',
    followupDays: settings.getFollowupDays(),
    autoSend: settings.raw('AGENT_AUTOSEND') === 'true',
  };
}

export async function saveAgentSettings(s: Partial<AgentSettings>): Promise<void> {
  await settings.saveSettings({
    AGENT_ENABLED: s.enabled ? 'true' : 'false',
    AGENT_CITY: s.city || '',
    AGENT_SENDER_SHOP_ID: s.senderShopId || '',
    FOLLOWUP_DAYS: String(s.followupDays || 3),
    AGENT_AUTOSEND: s.autoSend ? 'true' : 'false',
  });
}

export interface Lead {
  name: string;
  city: string;
  phone: string;
  instagram: string;
  source: string;
  notes: string;
}

/**
 * Discover flower/gift shops in a city via Google Places. Real data only.
 */
export async function discoverLeads(city: string): Promise<Lead[]> {
  const key = settings.raw('GOOGLE_PLACES_API_KEY');
  if (!key) {
    agentLog('[تنبيه] لا يوجد مفتاح Google Places API. أضِفه من «إعدادات النظام» لتفعيل البحث الحقيقي. لن يتم اختلاق بيانات.');
    return [];
  }

  agentLog(`[بدء] البحث عن محلات الورد والهدايا في «${city}» عبر Google Places...`);
  try {
    const query = encodeURIComponent(`محل ورد وهدايا ${city}`);
    const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&language=ar&region=sa&key=${key}`;
    const resp = await axios.get(url, { timeout: 15000 });

    if (resp.data.status && resp.data.status !== 'OK' && resp.data.status !== 'ZERO_RESULTS') {
      agentLog(`[خطأ] Google Places رفض الطلب: ${resp.data.status}${resp.data.error_message ? ' - ' + resp.data.error_message : ''}`);
      return [];
    }

    const results = (resp.data.results || []).slice(0, 12);
    const leads: Lead[] = [];

    for (const place of results) {
      let phone = '';
      try {
        const det = await axios.get(
          `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=international_phone_number,formatted_phone_number&language=ar&key=${key}`,
          { timeout: 12000 }
        );
        phone = (det.data.result?.international_phone_number || det.data.result?.formatted_phone_number || '').replace(/[\s-]/g, '');
      } catch {
        /* phone optional */
      }
      leads.push({
        name: place.name,
        city,
        phone,
        instagram: '',
        source: 'Google Maps',
        notes: place.formatted_address || '',
      });
    }

    agentLog(`[انتهاء] تم العثور على ${leads.length} متجر في «${city}». راجِعها وأضِف المناسب منها.`);
    return leads;
  } catch (err: any) {
    agentLog(`[خطأ] فشل البحث: ${err.message}`);
    return [];
  }
}

function shopToConfig(shop: any): WhatsAppConfig {
  return {
    whatsappType: shop.whatsappType as 'BUSINESS' | 'NORMAL',
    shopId: shop.id,
    token: shop.whatsappToken,
    phoneId: shop.whatsappPhoneId,
    adminGroupId: shop.whatsappAdminGroupId,
    ultramsgInstanceId: shop.ultramsgInstanceId,
    ultramsgToken: shop.ultramsgToken,
  };
}

/**
 * Send a single message to a prospect via an existing shop's WhatsApp session,
 * and record it on the prospect. Throws on failure.
 */
export async function sendViaBot(prospectId: string, senderShopId: string, message: string): Promise<void> {
  const prospect = await prisma.prospect.findUnique({ where: { id: prospectId } });
  if (!prospect) throw new Error('العميل المحتمل غير موجود');
  if (!prospect.phone) throw new Error('لا يوجد رقم واتساب لهذا المتجر');

  const shop = await prisma.shop.findUnique({ where: { id: senderShopId } });
  if (!shop) throw new Error('جلسة الإرسال غير موجودة');

  const to = prospect.phone.replace(/\D/g, '');
  await sendTextMessage(shopToConfig(shop), to, message);

  await prisma.prospect.update({
    where: { id: prospectId },
    data: {
      status: prospect.status === 'NEW' ? 'CONTACTED' : prospect.status,
      lastContact: new Date(),
      notes: (prospect.notes ? prospect.notes + '\n' : '') + `[أُرسلت رسالة عبر البوت — ${ts()}]`,
    },
  });

  agentLog(`[إرسال] رسالة إلى «${prospect.name}» (${to}) عبر متجر «${shop.name}».`);
}

const MAX_SENDS_PER_CYCLE = 10;
const SEND_DELAY_MS = 5000;

/**
 * One autonomous cycle: find stale follow-ups and (if autoSend) send a follow-up
 * draft to those already-contacted prospects. Never cold-messages new leads.
 */
export async function runCycle(): Promise<void> {
  if (running) {
    agentLog('[تنبيه] هناك دورة قيد التشغيل بالفعل.');
    return;
  }
  running = true;
  try {
    const s = getAgentSettings();
    agentLog('[بدء] انطلاق دورة الوكيل.');

    const active = await prisma.prospect.findMany({
      where: { status: { in: ['CONTACTED', 'INTERESTED', 'DEMO'] } },
    });
    const now = Date.now();
    const due = active.filter((p) => {
      const base = p.lastContact ? new Date(p.lastContact).getTime() : new Date(p.updatedAt).getTime();
      return now - base >= s.followupDays * 86400000;
    });

    agentLog(`[معلومة] ${due.length} متجر بحاجة متابعة (مرّ ${s.followupDays} أيام أو أكثر).`);

    if (!s.autoSend || !s.senderShopId) {
      agentLog('[معلومة] الإرسال التلقائي معطّل أو لا توجد جلسة إرسال — المتابعات تحتاج إرسالاً يدوياً من القائمة.');
      agentLog('[انتهاء] انتهت الدورة.');
      return;
    }

    let sent = 0;
    for (const p of due) {
      if (!p.phone) continue;
      if (sent >= MAX_SENDS_PER_CYCLE) {
        agentLog(`[تنبيه] بلغنا الحد الأقصى ${MAX_SENDS_PER_CYCLE} رسالة في الدورة (حماية من الحظر). الباقي في الدورة القادمة.`);
        break;
      }
      try {
        const variants = await generateOutreachDrafts(
          { name: p.name, city: p.city, source: p.source, notes: p.notes },
          'follow_up'
        );
        await sendViaBot(p.id, s.senderShopId, variants[0]);
        sent++;
        await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
      } catch (e: any) {
        agentLog(`[خطأ] فشل إرسال متابعة لـ «${p.name}»: ${e.message}`);
      }
    }
    agentLog(`[انتهاء] أُرسلت ${sent} رسالة متابعة. انتهت الدورة.`);
  } catch (err: any) {
    agentLog(`[خطأ] خطأ في الدورة: ${err.message}`);
  } finally {
    running = false;
  }
}
