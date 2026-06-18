import http from 'k6/http';
import { check, sleep } from 'k6';

// إعدادات الفحص
export const options = {
  // مراحل الفحص: زيادة الحمل، الثبات، ثم الانخفاض
  stages: [
    { duration: '30s', target: 20 }, // زيادة المستخدمين الوهميين إلى 20 خلال 30 ثانية
    { duration: '1m', target: 20 },  // البقاء على 20 مستخدم لمدة دقيقة
    { duration: '30s', target: 0 },  // خفض عدد المستخدمين تدريجياً للصفر
  ],
  thresholds: {
    // تحديد شروط نجاح الفحص
    http_req_duration: ['p(95)<500'], // 95% من الطلبات يجب أن تكتمل في أقل من 500 ملي ثانية
    http_req_failed: ['rate<0.01'],   // نسبة الفشل يجب أن تكون أقل من 1%
  },
};

const BASE_URL = 'https://demo.wardat.xyz';

export default function () {
  // 1. اختبار الصفحة الرئيسية للمتجر
  const res1 = http.get(`${BASE_URL}/`);
  check(res1, {
    'homepage status is 200': (r) => r.status === 200,
    'homepage loads fast': (r) => r.timings.duration < 1000,
  });

  sleep(1);

  // 2. اختبار واجهة جلب بيانات المتجر (API)
  // يمكنك تغيير /api/public/shop/demo إذا كان الرابط مختلفاً
  const res2 = http.get(`${BASE_URL}/api/public/shop/demo`);
  check(res2, {
    'API status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
