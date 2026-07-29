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
export interface MailLayout {
  /** The inbox-list snippet. Without it clients repeat the heading, wasting the
   *  one line of copy a reader sees before deciding to open anything. */
  preheader: string;
  heading: string;
  body: string;
  cta: { href: string; label: string };
  /** How long the link lives. Stated up front because the alternative is a
   *  support ticket from someone who opened the mail the next morning. */
  expiry: string;
}

/** System stacks, deliberately. Gmail strips `@font-face`, so Geist cannot
 *  travel - a webfont here would silently degrade to whatever the client picks
 *  anyway. The character comes from the mono wordmark and the type scale
 *  instead, which survive everywhere. */
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

/** Sixteen cells of a film strip, alternating. Pure table cells with background
 *  colours: no image to be blocked, no border-radius for Word to drop, and it
 *  says "video tool" in a way a logo file cannot when images are off. */
function filmStrip(on: string, off: string): string {
  return Array.from({ length: 16 }, (_, i) =>
    `<td width="6" height="4" style="width:6px;height:4px;line-height:4px;font-size:0;background:${i % 2 ? off : on}">&nbsp;</td>`
  ).join("");
}

export function layout(input: MailLayout): string {
  const { preheader, heading, body, cta, expiry } = input;

  // Not escaping - a scheme check. Escaping makes `javascript:alert(1)` render
  // harmlessly as text but leaves it live as an href, and "impossible by
  // construction" has to cover the day a redirect target becomes a parameter.
  if (!/^https?:\/\//i.test(cta.href)) {
    throw new Error(`[email] refusing a non-http(s) link: ${cta.href}`);
  }
  // encodeURI first for URL syntax, then escapeHtml for attribute syntax: the
  // two encodings are not the same job and the href needs both.
  const href = escapeHtml(encodeURI(cta.href));

  return `<!doctype html>
<html lang="en" style="color-scheme:light dark;supported-color-schemes:light dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(heading)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  /* Clients that honour it get the brand's own dark. Clients that do not keep
     the light version, which is the safe direction: a hardcoded dark card is
     what auto-inversion mangles into dark-on-dark. */
  @media (prefers-color-scheme:dark){
    .cc-bg{background:#000!important}
    .cc-card{background:#0a0a0a!important;border-color:#262626!important}
    .cc-ink{color:#ededed!important}
    .cc-mute{color:#8f8f8f!important}
    .cc-rule{background:#262626!important}
    .cc-btn{background:#ededed!important}
    .cc-btn a{color:#000!important}
    .cc-url{color:#8f8f8f!important;background:#161616!important;border-color:#262626!important}
  }
  @media (max-width:600px){
    .cc-card{padding:28px 22px!important}
    .cc-h1{font-size:22px!important}
  }
</style>
</head>
<body class="cc-bg" style="margin:0;padding:0;background:#f4f4f5;font-family:${SANS}">
<div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0">${escapeHtml(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="cc-bg" style="background:#f4f4f5">
<tr><td align="center" style="padding:40px 16px">

<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px">

  <tr><td style="padding:0 0 20px">
    <!-- Uppercase wants tracking added, not removed: the negative letter-spacing
         that suits the lowercase logotype reads cramped on caps. -->
    <span class="cc-ink" style="font-family:${MONO};font-size:14px;font-weight:700;letter-spacing:0.14em;color:#0a0a0a">CLIPCLAP</span>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px"><tr>${filmStrip("#0a0a0a", "#d4d4d8")}</tr></table>
  </td></tr>

  <tr><td class="cc-card" style="background:#ffffff;border:1px solid #e4e4e7;border-radius:10px;padding:36px 34px">

    <h1 class="cc-h1 cc-ink" style="margin:0 0 12px;font-family:${SANS};font-size:24px;line-height:1.25;font-weight:650;letter-spacing:-0.02em;color:#0a0a0a">${escapeHtml(heading)}</h1>

    <p class="cc-ink" style="margin:0 0 28px;font-size:15px;line-height:1.6;color:#3f3f46">${escapeHtml(body)}</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td class="cc-btn" align="center" bgcolor="#0a0a0a" style="background:#0a0a0a;border-radius:8px">
        <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:220px" arcsize="17%" stroke="f" fillcolor="#0a0a0a"><w:anchorlock/><center style="color:#ffffff;font-family:${SANS};font-size:15px;font-weight:600"><![endif]-->
        <a href="${href}" style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:15px;font-weight:600;line-height:18px;color:#ffffff;text-decoration:none;border-radius:8px">${escapeHtml(cta.label)}</a>
        <!--[if mso]></center></v:roundrect><![endif]-->
      </td>
    </tr></table>

    <p class="cc-mute" style="margin:20px 0 0;font-size:13px;line-height:1.5;color:#71717a">${escapeHtml(expiry)}</p>

    <div class="cc-rule" style="height:1px;background:#e4e4e7;margin:26px 0 18px;font-size:0;line-height:1px">&nbsp;</div>

    <p class="cc-mute" style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#71717a">Button not working? Paste this into your browser:</p>
    <p class="cc-url" style="margin:0;padding:10px 12px;background:#fafafa;border:1px solid #e4e4e7;border-radius:6px;font-family:${MONO};font-size:11px;line-height:1.5;color:#52525b;word-break:break-all">${href}</p>

  </td></tr>

  <tr><td class="cc-mute" style="padding:20px 6px 0;font-size:12px;line-height:1.6;color:#71717a">
    You are getting this because someone used this address to sign up at clipclap.io. If that was not you, ignore this message - nothing happens until the link above is opened.
  </td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;
}

/** The plain-text alternative is not a courtesy. Some clients render it by
 *  preference, spam filters read it, and a one-line stub next to a full HTML
 *  part is itself a spam signal - so it carries the same words, the same link
 *  and the same expiry. */
function textVersion(
  heading: string,
  body: string,
  href: string,
  expiry: string
): string {
  return [
    heading,
    "",
    body,
    "",
    href,
    "",
    expiry,
    "",
    "You are getting this because someone used this address to sign up at clipclap.io.",
    "If that was not you, ignore this message - nothing happens until the link is opened.",
  ].join("\n");
}

export async function sendVerificationEmail(
  to: string,
  token: string
): Promise<boolean> {
  const href = `${APP_URL}/api/auth/verify?token=${token}`;
  // No number in the copy: the free allowance lives in config, and hardcoding
  // it here would drift silently the first time it changes.
  const heading = "Confirm your email";
  const body =
    "One click and your free minutes are unlocked. We only need to know the address is yours.";
  const expiry = "This link works for 24 hours and can be used once.";
  return sendEmail({
    to,
    subject: "Confirm your ClipClap email",
    text: textVersion(heading, body, href, expiry),
    html: layout({
      preheader: "One click unlocks your free minutes - the link lasts 24 hours.",
      heading,
      body,
      cta: { href, label: "Confirm email" },
      expiry,
    }),
  });
}

export async function sendPasswordResetEmail(
  to: string,
  token: string
): Promise<boolean> {
  const href = `${APP_URL}/reset?token=${token}`;
  const heading = "Reset your password";
  const body =
    "Pick a new password for your ClipClap account. Your current one keeps working until you do.";
  // Shorter than the verification window on purpose, and said out loud: a reset
  // link is the one thing worth stealing out of a mailbox.
  const expiry = "This link works for one hour and can be used once.";
  return sendEmail({
    to,
    subject: "Reset your ClipClap password",
    text: textVersion(heading, body, href, expiry),
    html: layout({
      preheader: "Set a new password - the link lasts one hour.",
      heading,
      body,
      cta: { href, label: "Set a new password" },
      expiry,
    }),
  });
}
