import nodemailer from 'nodemailer';
import logger from '../utils/logger';
import { getSmtp } from './settings';

/**
 * SMTP-based mailer. Configuration comes from the settings service
 * (DB override → SMTP_* env vars). The transporter is rebuilt automatically
 * whenever the SMTP configuration changes (keyed by a signature), so edits in
 * the admin panel take effect without a restart.
 *
 * If SMTP is not configured, emails are not sent but their content (including the
 * reset link) is logged, so the flow still works in development.
 */

let transporter: nodemailer.Transporter | null = null;
let signature = '';

function getTransporter(): nodemailer.Transporter | null {
  const smtp = getSmtp();
  if (!smtp.host || !smtp.user || !smtp.pass) {
    return null; // not configured
  }

  const sig = `${smtp.host}|${smtp.port}|${smtp.secure}|${smtp.user}|${smtp.pass}`;
  if (transporter && sig === signature) return transporter;

  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });
  signature = sig;
  return transporter;
}

export function isEmailConfigured(): boolean {
  return getTransporter() !== null;
}

export async function sendEmail(to: string, subject: string, html: string, text?: string): Promise<void> {
  const tx = getTransporter();
  const smtp = getSmtp();
  const from = smtp.from || smtp.user || 'no-reply@wardat.xyz';

  if (!tx) {
    logger.warn(`[Email] SMTP not configured. Would have sent to ${to} | Subject: ${subject}`);
    if (text) logger.warn(`[Email] (dev) Body: ${text}`);
    return;
  }

  try {
    await tx.sendMail({ from, to, subject, html, text });
    logger.info(`[Email] Sent "${subject}" to ${to}`);
  } catch (err: any) {
    logger.error(`[Email] Failed to send to ${to}: ${err.message}`);
    throw err;
  }
}

/**
 * Build and send a password-reset email containing a one-time link.
 */
export async function sendPasswordResetEmail(
  to: string,
  shopName: string,
  resetLink: string
): Promise<void> {
  const subject = 'إعادة تعيين كلمة المرور | منصة وردات';
  const text =
    `مرحباً ${shopName},\n\n` +
    `تلقينا طلباً لإعادة تعيين كلمة مرور حسابك.\n` +
    `افتح الرابط التالي خلال 60 دقيقة لتعيين كلمة مرور جديدة:\n${resetLink}\n\n` +
    `إذا لم تطلب ذلك، تجاهل هذه الرسالة.`;

  const html = `
  <div dir="rtl" style="font-family: Tahoma, Arial, sans-serif; background:#0f0c20; padding:30px; color:#f5f3f7;">
    <div style="max-width:480px; margin:auto; background:#15102a; border-radius:16px; padding:30px; border:1px solid rgba(255,255,255,0.07);">
      <h2 style="background:linear-gradient(to left,#ff2d81,#8e2de2); -webkit-background-clip:text; background-clip:text; color:#ff2d81; margin:0 0 10px;">وردات | WARDAT</h2>
      <p style="color:#b1a9c3;">مرحباً <strong style="color:#f5f3f7;">${shopName}</strong>،</p>
      <p style="color:#b1a9c3; line-height:1.7;">تلقينا طلباً لإعادة تعيين كلمة مرور حسابك. اضغط على الزر أدناه لتعيين كلمة مرور جديدة. الرابط صالح لمدة <strong>60 دقيقة</strong>.</p>
      <div style="text-align:center; margin:28px 0;">
        <a href="${resetLink}" style="display:inline-block; background:linear-gradient(to right,#ff2d81,#8e2de2); color:#fff; text-decoration:none; padding:14px 32px; border-radius:12px; font-weight:bold;">إعادة تعيين كلمة المرور</a>
      </div>
      <p style="color:#8d85a3; font-size:13px;">إذا لم تطلب ذلك، يمكنك تجاهل هذه الرسالة بأمان.</p>
      <p style="color:#8d85a3; font-size:12px; word-break:break-all;">أو انسخ هذا الرابط: ${resetLink}</p>
    </div>
  </div>`;

  await sendEmail(to, subject, html, text);
}
