/** Bidirectional isolation for values interpolated into right-to-left copy.
 *
 *  In an RTL paragraph the Unicode bidi algorithm reorders a run of Latin text
 *  together with the punctuation touching it, so "زر ${url}." can render with
 *  the full stop at the wrong end of the link, and a referral code sitting
 *  between two Arabic words can appear to belong to the wrong one. Wrapping
 *  the substituted value pins it: everything between the two marks is laid out
 *  independently of the surrounding direction.
 *
 *  Used ONLY from ar.ts. The other dictionaries are left-to-right and would
 *  gain nothing but two invisible characters per interpolation.
 *
 *  NEVER put these marks in a keyboard label. Labels are compared by exact
 *  string against the text Telegram echoes back, across every locale at once,
 *  and an invisible character inside one turns a broken button into a silent
 *  one. An assertion in the bot's i18n suite enforces that. */

/** U+2068 FIRST STRONG ISOLATE - direction taken from the first strong
 *  character inside, which is what makes this right for values whose script is
 *  not known in advance (a URL, a username, a plan name, a number). */
const FSI = "\u2068";

/** U+2069 POP DIRECTIONAL ISOLATE. */
const PDI = "\u2069";

export function isolate(value: string | number): string {
  const text = String(value);
  if (text === "") return "";
  // Idempotent: isolating an isolated value would leave nested pairs, and an
  // unbalanced pair corrupts the layout of everything after it.
  if (text.startsWith(FSI) && text.endsWith(PDI)) return text;
  return `${FSI}${text}${PDI}`;
}
