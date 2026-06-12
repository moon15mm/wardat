import OpenAI from 'openai';
import axios from 'axios';
import { ChatMessage } from '../types';
import logger from '../utils/logger';

// Each shop uses ITS OWN OpenAI key. The platform key (env) is only a fallback
// for shops that haven't set one yet.
function getOpenAIClient(shopKey?: string | null): OpenAI | null {
  const key = (shopKey && shopKey.trim()) || process.env.OPENAI_API_KEY;
  if (!key || key.startsWith('your_')) return null;
  return new OpenAI({ apiKey: key });
}

const SYSTEM_PROMPT = `أنت مساعد متجر ورد ذكي على واتساب. تتحدث بالعربية بأسلوب ودود ومهني.

قواعدك:
- رحّب بالعميل بحرارة
- اعرض المنتجات بشكل واضح عند الطلب
- ساعد العميل في اختيار المنتج المناسب
- اجمع بيانات الطلب بالتسلسل: اسم العميل، رقم الجوال، اسم المستلم، عنوان التوصيل
- لا تطلب أكثر من معلومة واحدة في الرسالة الواحدة
- تأكد من صحة المعلومات قبل الانتقال للخطوة التالية
- لخّص الطلب قبل طلب التأكيد النهائي
- كن مختصراً وواضحاً
- استخدم الإيموجي باعتدال

لا تذكر أنك ذكاء اصطناعي. تصرف كموظف خدمة عملاء حقيقي.`;

// Google Gemini API Handlers
async function getGeminiResponse(
  messages: ChatMessage[],
  systemPrompt: string,
  apiKey: string
): Promise<string> {
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
  return response.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'عذراً، حدث خطأ في معالجة الرد.';
}

async function classifyIntentGemini(
  message: string,
  state: string,
  apiKey: string
): Promise<{ intent: string; extractedData?: Record<string, string> }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const systemInstruction = `حلل رسالة العميل وحدد النية. الحالة الحالية: ${state}
أرجع JSON فقط بهذا الشكل وبدون أي تنسيق markdown أو علامات اقتباس مائلة:
{"intent": "greeting|browse|select_product|provide_name|provide_phone|provide_recipient|provide_location|confirm|cancel|question|other", "extractedData": {"key": "value"}}`;

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
  return JSON.parse(content);
}

// Unified AI Interface exports
export async function getAIResponse(
  messages: ChatMessage[],
  productContext: string,
  shop: { aiProvider: string; geminiApiKey?: string | null; openaiApiKey?: string | null }
): Promise<string> {
  const provider = shop.aiProvider || 'OPENAI';

  if (provider === 'GEMINI') {
    const apiKey = shop.geminiApiKey || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      logger.error(`[AI] Gemini API Key missing for shop`);
      return 'عذراً، نظام الذكاء الاصطناعي غير مهيأ حالياً. يرجى إدخال مفتاح Gemini API في الإعدادات.';
    }
    try {
      return await getGeminiResponse(messages, SYSTEM_PROMPT + '\n\n' + productContext, apiKey);
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

    return response.choices[0]?.message?.content || 'عذراً، حدث خطأ. يرجى المحاولة مرة أخرى.';
  } catch (err: any) {
    logger.error(`OpenAI API error: ${err.message}`);
    return 'عذراً، النظام مشغول حالياً. يرجى المحاولة بعد قليل.';
  }
}

export async function classifyIntent(
  message: string,
  state: string,
  shop: { aiProvider: string; geminiApiKey?: string | null; openaiApiKey?: string | null }
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
      return await classifyIntentGemini(message, state, apiKey);
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
أرجع JSON فقط بهذا الشكل:
{"intent": "greeting|browse|select_product|provide_name|provide_phone|provide_recipient|provide_location|confirm|cancel|question|other", "extractedData": {"key": "value"}}`,
        },
        { role: 'user', content: message },
      ],
      max_tokens: 200,
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content || '{}';
    return JSON.parse(content);
  } catch {
    return { intent: 'other' };
  }
}
