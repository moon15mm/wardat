import OpenAI from 'openai';
import axios from 'axios';
import { ChatMessage } from '../types';
import logger from '../utils/logger';
import { recordAiUsage } from './ai-usage';

interface TokenUsage { promptTokens: number; completionTokens: number; }

// Extract token usage from a Gemini generateContent response (usageMetadata).
function geminiUsage(data: any): TokenUsage {
  const u = data?.usageMetadata || {};
  return {
    promptTokens: u.promptTokenCount || 0,
    completionTokens: u.candidatesTokenCount || 0,
  };
}

// Each shop uses ITS OWN OpenAI key. The platform key (env) is only a fallback
// for shops that haven't set one yet.
function getOpenAIClient(shopKey?: string | null): OpenAI | null {
  const key = (shopKey && shopKey.trim()) || process.env.OPENAI_API_KEY;
  if (!key || key.startsWith('your_')) return null;
  return new OpenAI({ apiKey: key });
}

const SYSTEM_PROMPT = `أنت مستشار مبيعات ذكي وودود لمتجر ورد وهدايا، تتحدث بالعربية بأسلوب طبيعي ومقنع كموظف خبير.

ستجد في الرسالة قائمة المنتجات بأسعارها وساعات التوصيل واسم المتجر. استخدمها للإجابة بدقة:
- أجب على سؤال العميل مباشرةً وبوضوح (الأسعار، التوصيل، المناسبات، الميزانية) — لا تتهرّب ولا تكتفِ بـ«اختر رقم المنتج».
- عند سؤاله عن مناسبة (تخرّج، خطوبة، عيد، تهنئة...) رشّح له منتجات محدّدة بالاسم والسعر من القائمة، واذكر سبب ملاءمتها باختصار.
- عند ذكره ميزانية معيّنة، اعرض المنتجات ضمن نطاقه بالاسم والسعر.
- عند سؤاله عن موعد/وقت التوصيل أو الاستلام، اذكر *ساعات العمل المتاحة* الموجودة في السياق بوضوح (من ... إلى ...)، ووضّح أنه يستطيع تحديد الوقت المناسب له ضمنها عند إتمام الطلب.
- لا تخترع منتجات أو أسعاراً غير موجودة في القائمة؛ إن لم تتوفّر معلومة فقل ذلك بلطف واقترح البديل الأقرب.
- بعد أن تجيب وتنصح، شجّع العميل بلطف على إتمام الطلب بإرسال *رقم المنتج* عندما يكون جاهزاً.
- إن كان وسط جمع بيانات طلب (اسم/مستلم/تأكيد) فأجب عن سؤاله ثم أعِده بلطف لإكمال تلك الخطوة.
- كن مختصراً ودافئاً، وإيموجي باعتدال.

لا تذكر أبداً أنك ذكاء اصطناعي؛ تصرّف كموظف مبيعات حقيقي محترف.`;

// Google Gemini API Handlers
async function getGeminiResponse(
  messages: ChatMessage[],
  systemPrompt: string,
  apiKey: string
): Promise<{ text: string; usage: TokenUsage }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

  // Map messages: Gemini roles are 'user' and 'model'
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body: any = {
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 500,
    },
  };

  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  const response = await axios.post(url, body);
  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'عذراً، حدث خطأ في معالجة الرد.';
  return { text, usage: geminiUsage(response.data) };
}

async function classifyIntentGemini(
  message: string,
  state: string,
  apiKey: string
): Promise<{ result: { intent: string; extractedData?: Record<string, string> }; usage: TokenUsage }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const systemInstruction = `حلل رسالة العميل وحدد النية. الحالة الحالية: ${state}
إذا كانت رسالة العميل تتضمن ألفاظاً مسيئة، سب وشتم، أو سلوكاً عبثياً وتخريبياً (مثل إرسال رسائل عشوائية متكررة لغرض الإزعاج وعدم الرغبة في الطلب)، حدد النية كـ "abuse".
أرجع JSON فقط بهذا الشكل وبدون أي تنسيق markdown أو علامات اقتباس مائلة:
{"intent": "greeting|browse|select_product|provide_name|provide_phone|provide_recipient|provide_location|confirm|cancel|question|abuse|other", "extractedData": {"key": "value"}}`;

  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: message }],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 200,
      responseMimeType: 'application/json',
    },
  };

  const response = await axios.post(url, body);
  const content = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return { result: JSON.parse(content), usage: geminiUsage(response.data) };
}

// Unified AI Interface exports
export async function getAIResponse(
  messages: ChatMessage[],
  productContext: string,
  shop: { id?: string; aiProvider: string; geminiApiKey?: string | null; openaiApiKey?: string | null }
): Promise<string> {
  const provider = shop.aiProvider || 'OPENAI';

  if (provider === 'GEMINI') {
    const apiKey = shop.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      logger.error(`[AI] Gemini API Key missing for shop`);
      return 'عذراً، نظام الذكاء الاصطناعي غير مهيأ حالياً. يرجى إدخال مفتاح Gemini API في الإعدادات.';
    }
    try {
      const { text, usage } = await getGeminiResponse(messages, SYSTEM_PROMPT + '\n\n' + productContext, apiKey);
      await recordAiUsage(shop.id, 'GEMINI', usage.promptTokens, usage.completionTokens);
      return text;
    } catch (err: any) {
      logger.error(`[AI] Gemini API Error: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
      return 'عذراً، نظام الذكاء الاصطناعي مشغول حالياً. يرجى المحاولة بعد قليل.';
    }
  }

  // OPENAI (per-shop key)
  const openai = getOpenAIClient(shop.openaiApiKey);
  if (!openai) {
    logger.error('[AI] OpenAI API Key missing for shop');
    return 'عذراً، نظام الذكاء الاصطناعي غير مهيأ حالياً. يرجى إدخال مفتاح OpenAI API في إعدادات المتجر.';
  }
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + '\n\n' + productContext },
        ...messages.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      ],
      max_tokens: 500,
      temperature: 0.7,
    });

    await recordAiUsage(shop.id, 'OPENAI', response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0);
    return response.choices[0]?.message?.content || 'عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.';
  } catch (err: any) {
    logger.error(`OpenAI API error: ${err.message}`);
    return 'عذراً، النظام مشغول حالياً. يرجى المحاولة بعد قليل.';
  }
}

export async function classifyIntent(
  message: string,
  state: string,
  shop: { id?: string; aiProvider: string; geminiApiKey?: string | null; openaiApiKey?: string | null }
): Promise<{
  intent: string;
  extractedData?: Record<string, string>;
}> {
  const provider = shop.aiProvider || 'OPENAI';

  if (provider === 'GEMINI') {
    const apiKey = shop.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { intent: 'other' };
    }
    try {
      const { result, usage } = await classifyIntentGemini(message, state, apiKey);
      await recordAiUsage(shop.id, 'GEMINI', usage.promptTokens, usage.completionTokens);
      return result;
    } catch (err: any) {
      logger.error(`[AI] Gemini classification error: ${err.message}`);
      return { intent: 'other' };
    }
  }

  // OPENAI (per-shop key)
  const openai = getOpenAIClient(shop.openaiApiKey);
  if (!openai) return { intent: 'other' };
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `حلل رسالة العميل وحدد النية. الحالة الحالية: ${state}
إذا كانت رسالة العميل تتضمن ألفاظاً مسيئة، سب وشتم، أو سلوكاً عبثياً وتخريبياً (مثل إرسال رسائل عشوائية متكررة لغرض الإزعاج وعدم الرغبة في الطلب)، حدد النية كـ "abuse".
أرجع JSON فقط بهذا الشكل:
{"intent": "greeting|browse|select_product|provide_name|provide_phone|provide_recipient|provide_location|confirm|cancel|question|abuse|other", "extractedData": {"key": "value"}}`,
        },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    await recordAiUsage(shop.id, 'OPENAI', response.usage?.prompt_tokens || 0, response.usage?.completion_tokens || 0);
    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content);
  } catch {
    return { intent: 'other' };
  }
}
