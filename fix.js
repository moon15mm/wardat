const fs = require('fs');
const file = 'public/dashboard/index.html';
let data = fs.readFileSync(file, 'utf8');

const regex = /<li style="margin-bottom:10px;">.*?\*\*.*?الفضية\*\*[\s\S]*?<li style="margin-bottom:10px;">.*?\*\*.*?البلاتينية\*\*.*?<\/li>/;

const newText = `<li style="margin-bottom:10px;">🥈 **الباقة الفضية**: بوت المبيعات الذكي، لغاية 500 طلب شهرياً، الدفع عند الاستلام وبوابة النظام.</li>
              <li style="margin-bottom:10px;">🥇 **الباقة الذهبية**: طلبات مبيعات غير محدودة، بوابات دفع خاصة بك، تقارير مالية، نشر حالات واتساب يدوياً وتلقائياً، بوت إدارة، وجروب التنبيهات.</li>
              <li style="margin-bottom:10px;">💎 **الباقة البلاتينية**: كل ميزات الذهبية + مفتاح OpenAI مخصص للاستهلاك اللامحدود للذكاء الاصطناعي.</li>`;

if (data.match(regex)) {
    data = data.replace(regex, newText);
    fs.writeFileSync(file, data, 'utf8');
    console.log('Fixed successfully');
} else {
    console.log('Regex did not match');
}
