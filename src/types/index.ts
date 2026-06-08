export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  imageUrl: string;
  category: string;
  available: boolean;
}

export interface Order {
  id: string;
  timestamp: string;
  customerName: string;
  customerPhone: string;
  recipientName: string;
  product: string;
  price: number;
  paymentStatus: 'PENDING' | 'CONFIRMED' | 'FAILED';
  locationUrl: string;
  cardLast4: string;
  productImageUrl: string;
  notes: string;
  stripeSessionId?: string;
}

export type ConversationState =
  | 'GREETING'
  | 'BROWSING'
  | 'SELECTING_PRODUCT'
  | 'COLLECTING_NAME'
  | 'COLLECTING_PHONE'
  | 'COLLECTING_RECIPIENT'
  | 'COLLECTING_LOCATION'
  | 'CONFIRMING_ORDER'
  | 'AWAITING_PAYMENT'
  | 'COMPLETED';

export interface Session {
  phone: string;
  state: ConversationState;
  messages: ChatMessage[];
  orderData: Partial<Order>;
  lastActivity: number;
  selectedProduct?: Product;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface WhatsAppMessage {
  from: string;
  type: 'text' | 'location' | 'image' | 'interactive';
  text?: { body: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  image?: { id: string; mime_type: string };
}

export interface PaymentRequest {
  orderId: string;
  customerPhone: string;
  customerName: string;
  product: string;
  price: number;
  currency: string;
}

export interface StripeWebhookData {
  orderId: string;
  sessionId: string;
  cardLast4: string;
  amount: number;
}
