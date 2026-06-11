import fs from 'fs';
import path from 'path';

const LOG_FILE = path.resolve(__dirname, '../../logs/agent.log');

export function logAgentAction(message: string): void {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const timestamp = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });
    const logLine = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.error('Failed to write agent log:', err);
  }
}

export function getAgentLogs(limit = 100): string[] {
  if (!fs.existsSync(LOG_FILE)) {
    return [];
  }
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = content.split('\n').filter(l => l.trim() !== '');
    return lines.slice(-limit);
  } catch (err) {
    return [];
  }
}

export function clearAgentLogs(): void {
  try {
    if (fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, '', 'utf8');
    }
  } catch (err) {}
}
