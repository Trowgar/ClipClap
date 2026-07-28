import { Resend } from "resend";

const FROM = process.env.EMAIL_FROM || "ClipClap <hello@clipclap.io>";
/** Same chain the bot and billing use, plus NEXT_PUBLIC_APP_URL, which is the
 *  one actually set in production. Getting this wrong sends dead links, so it
 *  falls back rather than assuming a single variable is present. */
const APP_URL =
  process.env.APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXTAUTH_URL ||
  "https://clipclap.io";

let client: Resend | null = null;
function resend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

/**
 * Sends, and never throws.
 *
 * Registration must not fail because a mail provider is down: the account is
 * created either way and the user can ask for another link. The caller gets a
 * boolean so it can log, not so it can abort.
 */
export async function sendEmail(input: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<boolean> {
  const api = resend();
  if (!api) {
    console.warn("[email] RESEND_API_KEY unset, not sending:", input.subject);
    return false;
  }

  try {
    const { error } = await api.emails.send({
      from: FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    });
    if (error) {
      console.error("[email] send failed:", error);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[email] send threw:", error);
    return false;
  }
}

/**
 * Interpolates straight into HTML with no escaping. Every argument below is an
 * internal constant or a hex token we generated - keep it that way. If a
 * caller ever wants to put a user's own text in a mail, escape it first.
 */
function layout(
  heading: string,
  body: string,
  cta: { href: string; label: string }
): string {
  return `<div style="font-family:system-ui,sans-serif;background:#000;color:#ededed;padding:32px">
  <h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>
  <p style="margin:0 0 24px;line-height:1.5">${body}</p>
  <a href="${cta.href}" style="display:inline-block;background:#ededed;color:#000;padding:12px 20px;border-radius:6px;text-decoration:none">${cta.label}</a>
  <p style="margin:24px 0 0;font-size:12px;color:#888">If you did not ask for this, ignore this message.</p>
</div>`;
}

export async function sendVerificationEmail(
  to: string,
  token: string
): Promise<boolean> {
  const href = `${APP_URL}/api/auth/verify?token=${token}`;
  return sendEmail({
    to,
    subject: "Confirm your ClipClap email",
    text: `Confirm your email to unlock your free minutes: ${href}`,
    html: layout(
      "Confirm your email",
      "Confirm this address to unlock your 60 free minutes of video.",
      { href, label: "Confirm email" }
    ),
  });
}

export async function sendPasswordResetEmail(
  to: string,
  token: string
): Promise<boolean> {
  const href = `${APP_URL}/reset?token=${token}`;
  return sendEmail({
    to,
    subject: "Reset your ClipClap password",
    text: `Reset your password: ${href} - the link is good for one hour.`,
    html: layout(
      "Reset your password",
      "Pick a new password. This link works for one hour.",
      { href, label: "Set a new password" }
    ),
  });
}
