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
  try {
    // Inside the try on purpose: the never-throws guarantee must be ours, not
    // a bet that the vendor's constructor stays non-throwing.
    const api = resend();
    if (!api) {
      console.warn("[email] RESEND_API_KEY unset, not sending:", input.subject);
      return false;
    }

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
 * HTML-escapes a value for interpolation into mail we sign with our own DKIM
 * key. `&` has to go first or it would double-escape the entities added after
 * it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes every interpolated value, so callers cannot inject markup even by
 * accident. Today's arguments are all internal constants, but this repo has a
 * referral system: the first "your referral signed up" mail would put another
 * user's chosen display name into a victim's inbox, inside a message our own
 * domain vouches for. That is phishing forged under our name, not self-XSS,
 * and a comment asking callers to be careful cannot prevent it. If some future
 * caller genuinely needs markup, add an explicit opt-out then - not before.
 *
 * Exported only so the escaping can be tested where it is APPLIED. Testing
 * `escapeHtml` alone proves nothing: dropping the call from one interpolation
 * here reopens the hole with every test still green, which is exactly what a
 * mutation run found.
 *
 * `cta.href` must be a RAW, unencoded URL. It is passed through `encodeURI`,
 * so a pre-encoded value is double-encoded - `a%40b.com` becomes `a%2540b.com`
 * and the link silently dies.
 */
export function layout(
  heading: string,
  body: string,
  cta: { href: string; label: string }
): string {
  // Not escaping - a scheme check. Escaping makes `javascript:alert(1)` render
  // harmlessly as text but leaves it live as an href, and "impossible by
  // construction" has to cover the day a redirect target becomes a parameter.
  if (!/^https?:\/\//i.test(cta.href)) {
    throw new Error(`[email] refusing a non-http(s) link: ${cta.href}`);
  }
  // encodeURI first for URL syntax, then escapeHtml for attribute syntax: the
  // two encodings are not the same job and the href needs both.
  const href = escapeHtml(encodeURI(cta.href));
  return `<div style="font-family:system-ui,sans-serif;background:#000;color:#ededed;padding:32px">
  <h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>
  <p style="margin:0 0 24px;line-height:1.5">${escapeHtml(body)}</p>
  <a href="${href}" style="display:inline-block;background:#ededed;color:#000;padding:12px 20px;border-radius:6px;text-decoration:none">${escapeHtml(cta.label)}</a>
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
    // No number in the copy: the free allowance lives in config, and hardcoding
    // it here would drift silently the first time it changes.
    html: layout(
      "Confirm your email",
      "Confirm this address to unlock your free minutes of video.",
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
