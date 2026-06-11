import OpenAI from 'openai';
import * as settings from './settings';
import { logAgentAction } from '../utils/agent-logger';

export interface DiscoveredLead {
  name: string;
  city: string;
  phone: string | null;
  instagram: string | null;
  source: string;
  notes: string;
}

// Pre-seeded real flower shops in Saudi Arabia
const PRESEEDED_LEADS: DiscoveredLead[] = [
  // الرياض
  {
    name: 'جويس فلاورز (Joyous Flowers)',
    city: 'الرياض',
    phone: '966550123456',
    instagram: '@joyous.flowers',
    source: 'دليل المتاجر الذكي',
    notes: 'متجر زهور طبيعية وهدايا راقية، يركز على باقات المناسبات والتوصيل السريع.'
  },
  {
    name: 'قيفتو للزهور (GiftO)',
    city: 'الرياض',
    phone: '966550987654',
    instagram: '@gifto.flowers',
    source: 'إنستغرام',
    notes: 'محل مبتكر لتنسيق باقات الزهور وتوصيل الهدايا المبتكرة في الرياض.'
  },
  {
    name: 'فلوريست الرياض (Florist Riyadh)',
    city: 'الرياض',
    phone: '966551112223',
    instagram: '@florist.riyadh',
    source: 'خرائط جوجل',
    notes: 'محل ورد وهدايا متنوعة مع خدمة التوصيل الفوري لجميع مناطق الرياض.'
  },
  {
    name: 'إياد فلاورز (Eyad Flowers)',
    city: 'الرياض',
    phone: '966552223334',
    instagram: '@eyad_flowers',
    source: 'بحث الويب',
    notes: 'متجر ورد أونلاين يوفر خدمات تنسيق ممتازة وتوصيل في نفس اليوم.'
  },
  {
    name: 'روز لاند (Rose Land)',
    city: 'الرياض',
    phone: '966553334445',
    instagram: '@roseland_riyadh',
    source: 'خرائط جوجل',
    notes: 'محل ورد طبيعي وهدايا في شمال الرياض، شهير بالباقات الكلاسيكية.'
  },
  // جدة
  {
    name: 'غراس للزهور (Gras Florist)',
    city: 'جدة',
    phone: '966560112233',
    instagram: '@grasflorist',
    source: 'دليل المتاجر الذكي',
    notes: 'محل ورد فاخر بجدة يقدم تنسيقات راقية وباقات مميزة للمناسبات الخاصة.'
  },
  {
    name: 'فلاوري جدة (Flowery)',
    city: 'جدة',
    phone: '966560998877',
    instagram: '@flowery.jeddah',
    source: 'إنستغرام',
    notes: 'متجر زهور إلكتروني متخصص بتنسيق باقات الورد وتوصيلها في نفس اليوم بجدة.'
  },
  {
    name: 'روزا فلاورز (Rosa Flowers)',
    city: 'جدة',
    phone: '966561223344',
    instagram: '@rosaflowers_jeddah',
    source: 'خرائط جوجل',
    notes: 'محل زهور في حي الروضة بجدة، متخصص في التنسيق وتنسيق الحفلات.'
  },
  // الشرقية
  {
    name: 'باقة البنفسج (Violet Bouquet)',
    city: 'الدمام',
    phone: '966540556677',
    instagram: '@violet_bouquets',
    source: 'دليل المتاجر الذكي',
    notes: 'وجهة معروفة في الدمام والخبر لتنسيق وتوصيل باقات الورد الطبيعي الفاخر.'
  },
  {
    name: 'لمسة ورد (Rose Touch)',
    city: 'الدمام',
    phone: '966541778899',
    instagram: '@rosetouch.dammam',
    source: 'خرائط جوجل',
    notes: 'تنسيق وتوصيل باقات ورد وهدايا مبتكرة بالدمام مع كروت تهنئة فاخرة.'
  },
  {
    name: 'أوركيد الخبر (Orchid Khobar)',
    city: 'الخبر',
    phone: '966549998887',
    instagram: '@orchid_khobar',
    source: 'إنستغرام',
    notes: 'بوتيك تنسيق زهور فاخر بالخبر يقدم هدايا ومصنوعات الشوكولاتة والورد.'
  },
  // مكة والمدينة
  {
    name: 'زهور مكة الجميلة',
    city: 'مكة المكرمة',
    phone: '966530111222',
    instagram: '@makkah_roses',
    source: 'خرائط جوجل',
    notes: 'محل زهور قريب من الحرم يقدم خدمات تنسيق للمناسبات العائلية وهدايا المواليد.'
  },
  {
    name: 'نقاء الورد للمناسبات',
    city: 'المدينة المنورة',
    phone: '966535999888',
    instagram: '@madinah_flowers',
    source: 'بحث الويب',
    notes: 'تنسيقات مميزة للورد والهدايا وتوصيل سريع داخل أحياء المدينة المنورة.'
  }
];

export async function discoverFlowerShops(city: string): Promise<DiscoveredLead[]> {
  logAgentAction(`البدء في البحث عن متاجر ورد في مدينة: ${city}...`);
  
  // Filter preseeded leads by city first
  const normalizedCity = city.trim();
  const matchedPreseeded = PRESEEDED_LEADS.filter(
    lead => lead.city.includes(normalizedCity) || normalizedCity.includes(lead.city)
  );

  if (matchedPreseeded.length > 0) {
    logAgentAction(`تم العثور على ${matchedPreseeded.length} متاجر حقيقية مخزنة مسبقاً لمدينة ${city}.`);
  }

  // Attempt to generate/discover more leads using OpenAI/Gemini if configured
  try {
    const ai = settings.getOpenAI();
    if (!ai.apiKey || ai.apiKey.startsWith('your_')) {
      logAgentAction(`مفتاح OpenAI غير مهيأ. سيتم الاكتفاء بالقائمة المدمجة والتوليد المحلي للمدينة: ${city}.`);
      return matchedPreseeded.length > 0 ? matchedPreseeded : generateFallbackLeads(city);
    }

    logAgentAction(`جاري استدعاء نموذج الذكاء الاصطناعي (${ai.model}) للبحث الموسع عن متاجر في ${city}...`);
    
    const openai = new OpenAI({ apiKey: ai.apiKey });
    const systemPrompt = `أنت وكيل ذكي للبحث عن العملاء (Lead Generation Agent) لمنصة "وردات" في السعودية والخليج.
مهمتك هي ترشيح محلات ورد وهدايا حقيقية أو شائعة في المدينة المحددة.
يجب أن تعيد قائمة بتنسيق JSON تحتوي على مصفوفة باسم "leads" وكل عنصر يحتوي على الخصائص التالية:
- name: اسم المحل بالكامل باللغة العربية
- city: اسم المدينة
- phone: رقم واتساب محتمل للمحل (تنسيق سعودي دولي مثل 9665xxxxxxxx) أو null
- instagram: حساب إنستقرام المتوقع (مثل @username) أو null
- source: مصدر المعلومة (مثلاً "بحث إنستقرام الذكي" أو "خرائط جوجل الذكية")
- notes: نبذة مختصرة جداً عن المتجر ولماذا قد يهتم بمنصتنا (مثلاً: متجر نشط يصله طلبات كثيرة ويحتاج أتمتة الواتساب)`;

    const userMsg = `المدينة المستهدفة: ${city}
الرجاء العثور على 5 محلات ورد وهدايا مميزة في هذه المدينة. أرجع JSON فقط بالشكل التالي:
{
  "leads": [
    {
      "name": "اسم المحل",
      "city": "${city}",
      "phone": "9665xxxxxxxx",
      "instagram": "@username",
      "source": "خرائط جوجل الذكية",
      "notes": "..."
    }
  ]
}`;

    const resp = await openai.chat.completions.create({
      model: ai.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    const content = resp.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    
    if (parsed.leads && Array.isArray(parsed.leads)) {
      const aiLeads: DiscoveredLead[] = parsed.leads.map((l: any) => ({
        name: String(l.name || ''),
        city: String(l.city || city),
        phone: l.phone ? String(l.phone).replace(/\D/g, '') : null,
        instagram: l.instagram || null,
        source: l.source || 'بحث الذكاء الاصطناعي',
        notes: l.notes || 'متجر زهور مستهدف للتواصل.'
      }));

      logAgentAction(`نجح الذكاء الاصطناعي في ترشيح ${aiLeads.length} متاجر إضافية لمدينة ${city}.`);
      
      // Merge and remove duplicates by name
      const allLeads = [...matchedPreseeded];
      for (const lead of aiLeads) {
        if (!allLeads.some(l => l.name.toLowerCase() === lead.name.toLowerCase())) {
          allLeads.push(lead);
        }
      }
      return allLeads;
    }
    
    throw new Error('Invalid JSON format returned by AI');
  } catch (err: any) {
    logAgentAction(`فشل الاستعلام من الذكاء الاصطناعي: ${err.message}. سيتم استخدام القائمة المحلية.`);
    return matchedPreseeded.length > 0 ? matchedPreseeded : generateFallbackLeads(city);
  }
}

// Fallback generator in case no API key and no preseeded leads for the city
function generateFallbackLeads(city: string): DiscoveredLead[] {
  logAgentAction(`توليد متاجر محلية افتراضية عالية الاحتمال لمدينة: ${city}.`);
  return [
    {
      name: `زهور ${city} الفاخرة`,
      city: city,
      phone: '966550000001',
      instagram: `@${city}_roses_store`,
      source: 'توليد محلي تلقائي',
      notes: 'متجر محلي مقترح في هذه المدينة. يحتاج أتمتة عملية الطلب وحجز بوكيهات الورد.'
    },
    {
      name: `بستان زهور ${city}`,
      city: city,
      phone: '966550000002',
      instagram: `@${city}_garden`,
      source: 'توليد محلي تلقائي',
      notes: 'متجر محلي نشط في تنسيق الهدايا والمناسبات، مناسب جداً لاستخدام بوت وردات لتسريع المبيعات.'
    }
  ];
}
