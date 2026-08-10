import nodemailer from 'nodemailer';

/**
 * Minimal SMTP sender. Faithful port of backend/app/mailer.py. In the demo it
 * targets the local Supabase Mailpit catcher (SMTP :54325, inbox UI :54324), so
 * "email notifications" are real and viewable. Best-effort: returns true/false,
 * never throws into the caller. Reads SMTP_* from process.env at call time so it
 * works identically in the Nest app and the standalone worker.
 */
export async function sendEmail(toAddrs: string[], subject: string, body: string): Promise<boolean> {
  const to = toAddrs.filter(Boolean);
  if (to.length === 0) return false;
  const host = process.env.SMTP_HOST ?? '127.0.0.1';
  const port = parseInt(process.env.SMTP_PORT ?? '54325', 10);
  const from = process.env.SMTP_FROM ?? 'announcements@hhcp.local';
  try {
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: false,
      // Mailpit needs no auth; short timeout keeps a dead relay from hanging.
      connectionTimeout: 5000,
    });
    await transport.sendMail({
      from: { name: 'HHCP Announcements', address: from },
      to,
      subject,
      text: body,
    });
    return true;
  } catch {
    return false;
  }
}
