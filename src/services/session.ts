import { Session, ConversationState, ChatMessage } from '../types';
import logger from '../utils/logger';

const sessions = new Map<string, Session>();

const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

export function getSession(phone: string): Session {
  let session = sessions.get(phone);

  if (session && Date.now() - session.lastActivity > SESSION_TIMEOUT) {
    logger.info(`Session expired for ${phone}`);
    sessions.delete(phone);
    session = undefined;
  }

  if (!session) {
    session = {
      phone,
      state: 'GREETING',
      messages: [],
      orderData: {},
      lastActivity: Date.now(),
    };
    sessions.set(phone, session);
    logger.info(`New session created for ${phone}`);
  }

  session.lastActivity = Date.now();
  return session;
}

export function updateSessionState(
  phone: string,
  state: ConversationState
): void {
  const session = getSession(phone);
  session.state = state;
  logger.info(`Session ${phone} state: ${state}`);
}

export function addMessage(phone: string, message: ChatMessage): void {
  const session = getSession(phone);
  session.messages.push(message);
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-10);
  }
}

export function clearSession(phone: string): void {
  sessions.delete(phone);
  logger.info(`Session cleared for ${phone}`);
}

export function getActiveSessionCount(): number {
  return sessions.size;
}
