export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  imageUrl: string;
  category: string;
  available: boolean;
  stock?: number;
}

export interface Order {
  id: string;
  shopId: string;
  timestamp: string;
  customerName: string;
  customerPhone: string;
  recipientName: string;
  product: string;
  price: number;
  paymentStatus: 'PENDING' | 'CONFIRMED' | 'FAILED';
  locationUrl: string;
  fulfillmentType?: 'DELIVERY' | 'PICKUP';
  preferredTime?: string;
  cardLast4: string;
  productImageUrl: string;
  notes: string;
  stripeSessionId?: string;
  productId?: string;
  // Transient fields used only inside session.orderData for the owner
  // "add product via WhatsApp" flow (never written to the Order table).
  tempProductName?: string;
  tempProductPrice?: number;
  tempProductImageUrl?: string;
}

export type ConversationState =
  | 'GREETING'
  | 'BROWSING'
  | 'SELECTING_PRODUCT'
  | 'COLLECTING_NAME'
  | 'COLLECTING_PHONE'
  | 'COLLECTING_RECIPIENT'
  | 'COLLECTING_FULFILLMENT'
  | 'COLLECTING_LOCATION'
  | 'COLLECTING_TIME'
  | 'CONFIRMING_ORDER'
  | 'AWAITING_PAYMENT'
  | 'COMPLETED'
  | 'OWNER_COLLECTING_PRODUCT_NAME'
  | 'OWNER_COLLECTING_PRODUCT_PRICE'
  | 'OWNER_COLLECTING_PRODUCT_DESC';

export interface Session {
  phone: string;
  state: ConversationState;
  messages: ChatMessage[];
  orderData: Partial<Order>;
  lastActivity: number;
  selectedProduct?: Product;
  botPaused?: boolean;
  tempProductData?: Partial<Product>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface WhatsAppMessage {
  from: string;
  type: string;
  text?: { body: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  image?: { id?: string; mime_type: string; buffer?: Buffer; caption?: string };
}

export interface PaymentRequest {
  orderId: string;
  shopId: string;
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
