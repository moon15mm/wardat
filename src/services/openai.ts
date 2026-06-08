import OpenAI from 'openai';
import { ChatMessage } from '../types';
import logger from '../utils/logger';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

export async function getAIResponse(
  messages: ChatMessage[],
  productContext: string
): Promise<string> {
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-nano',
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
  state: string
): Promise<{
  intent: string;
  extractedData?: Record<string, string>;
}> {
  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-nano',
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
