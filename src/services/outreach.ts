import OpenAI from 'openai';
import logger from '../utils/logger';
import * as settings from './settings';

/**
 * Outreach "agent" brain: drafts personalized Arabic outreach messages for a
 * prospective shop owner. It NEVER sends anything — it only returns drafts the
 * operator copies and sends manually (avoids spam / WhatsApp ToS issues).
 */

export type DraftKind = 'first_touch' | 'follow_up' | 'demo_invite';

export interface ProspectInput {
  name: string;
  city?: string | null;
  source?: string | null;
  notes?: string | null;
}

const KIND_BRIEF: Record<DraftKind, string> = {
  first_touch:
    'أول رسالة تواصل (تعريف مختصر ودود يلفت الانتباه دون مبالغة، يذكر فائدة ملموسة، وينتهي بسؤال بسيط يفتح الحوار).',
  follow_up:
    'رسالة متابعة لطيفة بعد عدم الرد (تذكير قصير غير ملحّ، يضيف قيمة أو دليلاً، ويترك الباب مفتوحاً).',
  demo_invite:
    'دعوة لعرض توضيحي/تجربة (اقتراح عرض سريع 5 دقائق أو تجربة مجانية، مع رابط الموقع وخطوة تالية واضحة).',
};

const baseUrl = () => settings.getAppBaseUrl();

export async function generateOutreachDrafts(
  prospect: ProspectInput,
  kind: DraftKind
): Promise<string[]> {
  const brief = KIND_BRIEF[kind] || KIND_BRIEF.first_touch;

  const system = `أنت مساعد مبيعات محترف لمنصة "وردات" (${baseUrl()}) — منصة SaaS تحوّل محلات الورد والهدايا إلى متجر بيع آلي على واتساب: ردّ آلي 24/7، استقبال الطلبات وجمع بيانات العميل والموقع، روابط دفع فورية، ولوحة تحكم بتحليلات.

مهمتك: صياغة رسائل تواصل (Outreach) موجّهة لأصحاب محلات الورد لإقناعهم بتجربة المنصة.

القواعد:
- اللهجة عربية احترافية ودودة (يمكن لمسة خليجية خفيفة)، مختصرة جداً ومناسبة للواتساب.
- مخصّصة باسم المتجر، وبدون مبالغات أو وعود غير واقعية، وبدون أسلوب سبام.
- ركّز على فائدة تشغيلية ملموسة (لا تضيّع طلبات بعد الدوام، رد فوري، دفع تلقائي).
- اختم بخطوة تالية واضحة وسؤال يفتح الحوار.
- لا تستخدم رموزاً مبالغاً بها؛ إيموجي باعتدال.
- أرجع JSON فقط بالشكل: {"variants": ["النص ١", "النص ٢"]} بنصّين مختلفين في الأسلوب.`;

  const userMsg = `نوع الرسالة المطلوبة: ${brief}

بيانات المتجر المستهدف:
- الاسم: ${prospect.name}
${prospect.city ? `- المدينة: ${prospect.city}\n` : ''}${prospect.source ? `- المصدر/أين وُجد: ${prospect.source}\n` : ''}${prospect.notes ? `- ملاحظات: ${prospect.notes}\n` : ''}
اكتب نصّين جاهزين للإرسال عبر واتساب.`;

  try {
    const ai = settings.getOpenAI();
    if (!ai.apiKey || ai.apiKey.startsWith('your_')) {
      // No real key configured → fall through to the static fallback below.
      throw new Error('OPENAI_API_KEY not configured');
    }
    const openai = new OpenAI({ apiKey: ai.apiKey });
    const resp = await openai.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.8,
      max_tokens: 600,
      response_format: { type: 'json_object' },
    });
    const content = resp.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    const variants = Array.isArray(parsed.variants) ? parsed.variants.filter((v: any) => typeof v === 'string' && v.trim()) : [];
    if (variants.length === 0) throw new Error('no variants');
    return variants.slice(0, 3);
  } catch (err: any) {
    logger.error(`[Outreach] Draft generation failed: ${err.message}`);
    // Fallback static draft so the feature still works without AI.
    const fallback =
      `مرحباً بكم في ${prospect.name} 🌹\n` +
      `نوفّر لكم عبر منصة "وردات" موظّف مبيعات آلي على واتساب يرد على عملائكم 24/7، يستقبل الطلبات ويجمع الموقع، ويرسل رابط دفع فوري.\n` +
      `حابّين نوريكم تجربة سريعة؟ التفاصيل: ${baseUrl()}`;
    return [fallback];
  }
}
