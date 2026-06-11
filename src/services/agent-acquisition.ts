import prisma from './db';
import * as settings from './settings';
import { logAgentAction } from '../utils/agent-logger';
import { discoverFlowerShops } from './lead-finder';
import { generateOutreachDrafts } from './outreach';
import { sendTextMessage, WhatsAppConfig } from './whatsapp';
import { getSessionStatus } from './baileys-manager';

export interface AgentSettings {
  enabled: boolean;
  city: string;
  senderShopId: string;
  followupDays: number;
  autoSend: boolean;
}

export async function getAgentSettings(): Promise<AgentSettings> {
  const enabledStr = await prisma.platformSetting.findUnique({ where: { key: 'ACQUISITION_AGENT_ENABLED' } });
  const cityStr = await prisma.platformSetting.findUnique({ where: { key: 'ACQUISITION_AGENT_CITY' } });
  const senderShopIdStr = await prisma.platformSetting.findUnique({ where: { key: 'ACQUISITION_AGENT_SENDER_SHOP_ID' } });
  const followupDaysStr = await prisma.platformSetting.findUnique({ where: { key: 'ACQUISITION_AGENT_FOLLOWUP_DAYS' } });
  const autoSendStr = await prisma.platformSetting.findUnique({ where: { key: 'ACQUISITION_AGENT_AUTO_SEND' } });

  return {
    enabled: enabledStr?.value === 'true',
    city: cityStr?.value || 'الرياض',
    senderShopId: senderShopIdStr?.value || '',
    followupDays: parseInt(followupDaysStr?.value || '3', 10),
    autoSend: autoSendStr?.value === 'true',
  };
}

export async function saveAgentSettings(updates: Partial<AgentSettings>): Promise<void> {
  const save = async (key: string, value: string) => {
    await prisma.platformSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  };

  if (updates.enabled !== undefined) await save('ACQUISITION_AGENT_ENABLED', String(updates.enabled));
  if (updates.city !== undefined) await save('ACQUISITION_AGENT_CITY', updates.city);
  if (updates.senderShopId !== undefined) await save('ACQUISITION_AGENT_SENDER_SHOP_ID', updates.senderShopId);
  if (updates.followupDays !== undefined) await save('ACQUISITION_AGENT_FOLLOWUP_DAYS', String(updates.followupDays));
  if (updates.autoSend !== undefined) await save('ACQUISITION_AGENT_AUTO_SEND', String(updates.autoSend));

  logAgentAction(`تم تحديث إعدادات الوكيل: ${JSON.stringify(updates)}`);
}

export async function runAcquisitionCycle(): Promise<void> {
  const config = await getAgentSettings();
  if (!config.enabled) {
    logAgentAction('الوكيل معطل حالياً في الإعدادات. تخطي دورة الاستحواذ.');
    return;
  }

  logAgentAction(`[بدء دورة الوكيل] تشغيل وكيل الاستحواذ لمدينة: ${config.city}...`);

  try {
    // 1. Discover Leads and save to database
    const discovered = await discoverFlowerShops(config.city);
    let addedCount = 0;
    
    for (const lead of discovered) {
      // Check if prospect already exists (by name or phone)
      const existing = await prisma.prospect.findFirst({
        where: {
          OR: [
            { name: lead.name },
            lead.phone ? { phone: lead.phone } : undefined
          ].filter(Boolean) as any
        }
      });

      if (!existing) {
        await prisma.prospect.create({
          data: {
            name: lead.name,
            city: lead.city,
            phone: lead.phone,
            instagram: lead.instagram,
            source: lead.source,
            status: 'NEW',
            notes: lead.notes
          }
        });
        addedCount++;
        logAgentAction(`اكتشاف عميل محتمل جديد: "${lead.name}" وتمت إضافته إلى قاعدة البيانات.`);
      }
    }

    logAgentAction(`انتهاء مرحلة الاكتشاف. تم إضافة ${addedCount} متاجر جديدة.`);

    // Check sender WhatsApp session if autoSend is enabled
    let senderSessionActive = false;
    let senderShop = null;
    let whatsappConfig: WhatsAppConfig | null = null;

    if (config.senderShopId) {
      senderShop = await prisma.shop.findUnique({ where: { id: config.senderShopId } });
      if (senderShop) {
        if (senderShop.whatsappType === 'NORMAL') {
          const status = getSessionStatus(senderShop.id);
          senderSessionActive = status.status === 'CONNECTED';
        } else {
          // Cloud API is assumed active if configured
          senderSessionActive = !!(senderShop.whatsappToken && senderShop.whatsappPhoneId);
        }

        if (senderSessionActive) {
          whatsappConfig = {
            whatsappType: senderShop.whatsappType as 'BUSINESS' | 'NORMAL',
            shopId: senderShop.id,
            token: senderShop.whatsappToken,
            phoneId: senderShop.whatsappPhoneId,
            adminGroupId: senderShop.whatsappAdminGroupId,
            ultramsgInstanceId: senderShop.ultramsgInstanceId,
            ultramsgToken: senderShop.ultramsgToken,
          };
        }
      }
    }

    // 2. Process NEW prospects for first touch outreach
    const newProspects = await prisma.prospect.findMany({ where: { status: 'NEW' } });
    logAgentAction(`معالجة ${newProspects.length} عملاء جدد للتواصل الأول...`);

    for (const prospect of newProspects) {
      if (!prospect.phone) {
        logAgentAction(`تخطي العميل "${prospect.name}" لعدم توفر رقم هاتف/واتساب.`);
        continue;
      }

      // Generate first touch message
      const drafts = await generateOutreachDrafts(
        { name: prospect.name, city: prospect.city, source: prospect.source, notes: prospect.notes },
        'first_touch'
      );
      const message = drafts[0];

      if (config.autoSend && senderSessionActive && whatsappConfig) {
        try {
          logAgentAction(`إرسال الرسالة الأولى تلقائياً إلى "${prospect.name}" (${prospect.phone})...`);
          await sendTextMessage(whatsappConfig, prospect.phone, message);
          
          await prisma.prospect.update({
            where: { id: prospect.id },
            data: {
              status: 'CONTACTED',
              lastContact: new Date(),
              notes: `${prospect.notes}\n[الوكيل] تم إرسال رسالة التواصل الأولى آلياً.`
            }
          });
          logAgentAction(`نجح إرسال الرسالة الأولى وتحديث حالة العميل "${prospect.name}" إلى "تم التواصل".`);
        } catch (sendErr: any) {
          logAgentAction(`فشل إرسال الرسالة لـ "${prospect.name}": ${sendErr.message}. تم حفظها كمسودة.`);
        }
      } else {
        // Just log the draft created
        logAgentAction(`تم صياغة مسودة تواصل أولى لـ "${prospect.name}": "${message.substring(0, 50)}..." (بانتظار الإرسال اليدوي).`);
      }
    }

    // 3. Process CONTACTED prospects for follow-ups
    const cutoffDate = new Date(Date.now() - config.followupDays * 24 * 60 * 60 * 1000);
    const pendingFollowups = await prisma.prospect.findMany({
      where: {
        status: 'CONTACTED',
        lastContact: {
          lt: cutoffDate
        }
      }
    });

    logAgentAction(`معالجة ${pendingFollowups.length} عملاء مستحقين لرسالة المتابعة (مرور ${config.followupDays} أيام)...`);

    for (const prospect of pendingFollowups) {
      if (!prospect.phone) continue;

      // Generate follow-up message
      const drafts = await generateOutreachDrafts(
        { name: prospect.name, city: prospect.city, source: prospect.source, notes: prospect.notes },
        'follow_up'
      );
      const message = drafts[0];

      if (config.autoSend && senderSessionActive && whatsappConfig) {
        try {
          logAgentAction(`إرسال رسالة متابعة تلقائية إلى "${prospect.name}" (${prospect.phone})...`);
          await sendTextMessage(whatsappConfig, prospect.phone, message);
          
          await prisma.prospect.update({
            where: { id: prospect.id },
            data: {
              lastContact: new Date(),
              notes: `${prospect.notes}\n[الوكيل] تم إرسال رسالة المتابعة آلياً.`
            }
          });
          logAgentAction(`نجح إرسال رسالة المتابعة إلى "${prospect.name}".`);
        } catch (sendErr: any) {
          logAgentAction(`فشل إرسال رسالة المتابعة لـ "${prospect.name}": ${sendErr.message}.`);
        }
      } else {
        logAgentAction(`مستحق للمتابعة: مسودة المتابعة لـ "${prospect.name}" جاهزة: "${message.substring(0, 50)}...".`);
      }
    }

    logAgentAction('[انتهاء دورة الوكيل] تم إكمال دورة الاستحواذ والمتابعة بنجاح.');
  } catch (err: any) {
    logAgentAction(`[خطأ في دورة الوكيل] فشل تشغيل الدورة بالكامل: ${err.message}`);
  }
}
