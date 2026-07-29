import { DISPOSABLE_EMAIL_DOMAINS } from "../config/disposable-domains";

/** Domains whose mailboxes ignore dots in the local part. */
const DOT_INSENSITIVE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function parseAddress(raw: string): { local: string; domain: string } | null {
  const trimmed = raw.trim().toLowerCase();
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  const [local, rawDomain] = parts;
  // A trailing dot is legal FQDN notation - receiving mail servers treat
  // "gmail.com." as the same mailbox as "gmail.com" - so it must be gone
  // before any comparison below, or it silently mints a second identity.
  const domain = rawDomain.replace(/\.+$/, "");
  if (!local || !domain || !domain.includes(".")) return null;
  return { local, domain };
}

/**
 * The identity behind an address, for uniqueness only.
 *
 * `oleg@gmail.com`, `o.l.e.g@gmail.com` and `oleg+anything@gmail.com` are one
 * mailbox and therefore one person, so they must collide on one account or the
 * free allowance is farmable from a single inbox. The raw address is still what
 * gets stored in `User.email` and what mail is delivered to - this value only
 * ever populates `User.emailCanonical`.
 *
 * Plus-addressing is stripped for every domain, not just gmail, because it is
 * not a gmail feature - Outlook, Yahoo, Proton and Fastmail (among others) all
 * honor it too, so gating the strip to gmail would leave the alias hole open on
 * every other major provider. Providers that reject `+` outright, iCloud among
 * them, cost us nothing here: mail to such an address never arrives, so the
 * account can never verify and never reaches the allowance. Dot-stripping stays
 * gmail-only because dots are significant in the local part almost
 * everywhere else. The two mistakes are not equally bad: wrongly collapsing
 * two distinct addresses just refuses a registration with a visible error,
 * while wrongly treating one mailbox as two silently hands out a second free
 * allowance that costs real money - so plus-stripping defaults to the
 * broader, safer rule.
 */
export function canonicalizeEmail(raw: string): string | null {
  const parts = parseAddress(raw);
  if (!parts) return null;

  const domain = DOT_INSENSITIVE_DOMAINS.has(parts.domain)
    ? "gmail.com"
    : parts.domain;

  let local = parts.local.split("+")[0];
  if (DOT_INSENSITIVE_DOMAINS.has(parts.domain)) {
    local = local.replace(/\./g, "");
  }
  if (!local) return null;

  return `${local}@${domain}`;
}

/** True for a known throwaway domain or any subdomain of one. */
export function isDisposableEmail(raw: string): boolean {
  const parts = parseAddress(raw);
  if (!parts) return false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(parts.domain)) return true;
  return [...DISPOSABLE_EMAIL_DOMAINS].some((d) =>
    parts.domain.endsWith(`.${d}`)
  );
}
