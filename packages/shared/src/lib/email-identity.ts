import { DISPOSABLE_EMAIL_DOMAINS } from "../config/disposable-domains";

/** Domains whose mailboxes ignore dots in the local part. */
const DOT_INSENSITIVE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function split(raw: string): { local: string; domain: string } | null {
  const trimmed = raw.trim().toLowerCase();
  const parts = trimmed.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
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
 */
export function canonicalizeEmail(raw: string): string | null {
  const parts = split(raw);
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
  const parts = split(raw);
  if (!parts) return false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(parts.domain)) return true;
  return [...DISPOSABLE_EMAIL_DOMAINS].some((d) =>
    parts.domain.endsWith(`.${d}`)
  );
}
