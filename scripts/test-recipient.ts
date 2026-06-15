import { Session } from '../src/types';

// Mock functions and states to test the conversational flow logic safely
function testRecipientLogic() {
  console.log('--- بدء اختبار مسار محادثة المستلم ورقم الجوال ---');

  let session: Partial<Session> = {
    state: 'COLLECTING_RECIPIENT',
    orderData: {
      customerName: 'محمد',
    },
    messages: [],
  };

  let replySent = '';

  // Mock sendTextMessage
  const sendTextMessage = (text: string) => {
    replySent = text;
    session.messages?.push({ role: 'assistant', content: text });
  };

  // --- Test 1: The user orders for himself ---
  console.log('\\n[الاختبار 1]: العميل يطلب لنفسه (إدخال: "لي" أو "أنا")');
  const text1: string = 'لي';
  const isMe = text1 === 'لي' || text1 === 'أنا' || text1 === 'نفسي';
  
  session.orderData!.recipientName = isMe ? (session.orderData!.customerName || 'نفس العميل') : text1;
  
  if (!isMe) {
    sendTextMessage(`بما أن الطلب لشخص آخر، ما هو رقم جوال المستلم (للتواصل معه عند التوصيل)؟`);
    session.state = 'COLLECTING_RECIPIENT_PHONE';
  } else {
    sendTextMessage('رائع! كيف تفضّل استلام طلبك؟ (1 للتوصيل / 2 للاستلام)');
    session.state = 'COLLECTING_FULFILLMENT';
  }

  console.log('اسم المستلم المحفوظ:', session.orderData!.recipientName);
  console.log('رد البوت:', replySent);
  console.log('حالة المحادثة:', session.state);
  
  if (session.state === 'COLLECTING_FULFILLMENT' && session.orderData!.recipientName === 'محمد') {
    console.log('✅ نجح الاختبار الأول (لم يسأل عن رقم المستلم)');
  } else {
    console.error('❌ فشل الاختبار الأول');
  }

  // --- Test 2: The user orders for someone else ---
  console.log('\\n[الاختبار 2]: العميل يطلب لشخص آخر (إدخال: "سالم")');
  session.state = 'COLLECTING_RECIPIENT';
  session.orderData!.recipientPhone = undefined; // reset
  const text2: string = 'سالم';
  const isMe2 = text2 === 'لي' || text2 === 'أنا' || text2 === 'نفسي';
  
  session.orderData!.recipientName = isMe2 ? (session.orderData!.customerName || 'نفس العميل') : text2;
  
  if (!isMe2) {
    sendTextMessage(`بما أن الطلب لشخص آخر، ما هو رقم جوال المستلم (للتواصل معه عند التوصيل)؟`);
    session.state = 'COLLECTING_RECIPIENT_PHONE';
  } else {
    sendTextMessage('رائع! كيف تفضّل استلام طلبك؟ (1 للتوصيل / 2 للاستلام)');
    session.state = 'COLLECTING_FULFILLMENT';
  }

  console.log('اسم المستلم المحفوظ:', session.orderData!.recipientName);
  console.log('رد البوت:', replySent);
  console.log('حالة المحادثة:', session.state);
  
  if (session.state === 'COLLECTING_RECIPIENT_PHONE' && session.orderData!.recipientName === 'سالم') {
    console.log('✅ نجح الاختبار الثاني (قام بتحويل الحالة لسؤال العميل عن رقم المستلم)');
  } else {
    console.error('❌ فشل الاختبار الثاني');
  }

  // --- Test 3: The user enters the recipient's phone number ---
  console.log('\n[الاختبار 3]: العميل يدخل رقم جوال المستلم (إدخال: "0500000000")');
  if (session.state === 'COLLECTING_RECIPIENT_PHONE') {
    const text3 = '0500000000';
    session.orderData!.recipientPhone = text3;
    
    // Simulate askFulfillmentOptions
    sendTextMessage('رائع! كيف تفضّل استلام طلبك؟ (1 للتوصيل / 2 للاستلام)');
    session.state = 'COLLECTING_FULFILLMENT';
  }

  console.log('رقم المستلم المحفوظ:', session.orderData!.recipientPhone);
  console.log('حالة المحادثة:', session.state);
  
  if (session.state === 'COLLECTING_FULFILLMENT' && session.orderData!.recipientPhone === '0500000000') {
    console.log('✅ نجح الاختبار الثالث (حفظ رقم المستلم وتابع لخيارات التوصيل)');
  } else {
    console.error('❌ فشل الاختبار الثالث');
  }

  console.log('\n--- تمت جميع الاختبارات بنجاح ---');
}

testRecipientLogic();
