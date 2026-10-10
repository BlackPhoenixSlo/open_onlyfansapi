import nodemailer from 'nodemailer';
import { env } from '../env.js';

export type Mail = { to: string; subject: string; text: string; html: string };
export type MailTransport = (mail: Mail) => Promise<void>;

function smtpTransport(host: string): MailTransport {
  const transporter = nodemailer.createTransport({
    host,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    // Not 465: refuse to send unless the server upgrades to TLS (STARTTLS).
    requireTLS: env.SMTP_PORT !== 465,
    // Do not let a hanging server hold a connection open.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    // env.ts requires SMTP_PASSWORD with SMTP_USER, and a sender (SMTP_FROM_EMAIL or SMTP_USER) with SMTP_HOST.
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD! } : undefined,
  });
  const address = (env.SMTP_FROM_EMAIL ?? env.SMTP_USER)!;
  const from = env.SMTP_FROM_NAME ? { name: env.SMTP_FROM_NAME, address } : address;
  return async (mail) => {
    await transporter.sendMail({ from, ...mail });
  };
}

/** No SMTP_HOST: print the mail (and so any link in it) to the API log instead of sending it. */
const logTransport: MailTransport = async (mail) => {
  console.info(`[mail] SMTP_HOST is not set, not sending. To: ${mail.to} | Subject: ${mail.subject}\n${mail.text}`);
};

let transport: MailTransport = env.SMTP_HOST ? smtpTransport(env.SMTP_HOST) : logTransport;

/** Replaces the transport (tests capture mail with it). */
export function setMailTransport(next: MailTransport): void {
  transport = next;
}

export function sendMail(mail: Mail): Promise<void> {
  return transport(mail);
}
