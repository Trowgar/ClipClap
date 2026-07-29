import Link from "next/link";
import { CheckCircle, Info, Warning } from "@phosphor-icons/react/dist/ssr";

/** The four values /api/auth/verify can redirect with. Anything else - a hand
 *  typed query, a stale bookmark - renders nothing rather than a fifth card. */
export type VerifiedStatus = "ok" | "not-found" | "expired" | "invalid";

export function parseVerifiedStatus(raw: unknown): VerifiedStatus | null {
  if (raw === "ok" || raw === "not-found" || raw === "expired" || raw === "invalid") {
    return raw;
  }
  return null;
}

type Tone = "success" | "neutral" | "warning";

const TONE_CLASS: Record<Tone, string> = {
  success: "border-emerald-500/25 bg-emerald-500/[0.07]",
  neutral: "border-white/[0.1] bg-white/[0.04]",
  warning: "border-amber-500/25 bg-amber-500/[0.06]",
};

const ICON_CLASS: Record<Tone, string> = {
  success: "text-emerald-400",
  neutral: "text-neutral-400",
  warning: "text-amber-400",
};

interface Copy {
  tone: Tone;
  title: string;
  body: string;
}

/**
 * What the four outcomes are allowed to say.
 *
 * `not-found` is the one that has to be written backwards from the obvious.
 * The token is burned by whoever opens the link first, and corporate mail
 * scanners open links before the human does - so the single most likely reader
 * of this message is someone whose address IS verified, either because the
 * scanner's fetch verified it or because they already clicked once themselves.
 * "Your email is not verified" would be wrong for nearly everyone who sees it,
 * and it would send them back to ask for a link they do not need. It says the
 * link is spent, and nothing about the state of the address.
 *
 * `ok` says the minutes are unlocked without naming a number: the allowance
 * lives in config and a figure typed here would drift the first time it moves,
 * exactly as the verification email itself already notes.
 */
const COPY: Record<VerifiedStatus, Copy> = {
  ok: {
    tone: "success",
    title: "Email confirmed",
    body: "Your address is confirmed and your free minutes are unlocked.",
  },
  "not-found": {
    tone: "neutral",
    title: "This link has already been used",
    body: "Confirmation links work once. If you clicked Confirm before - or your mail provider opened the link for you, which many do - then it already did its job and there is nothing left to do here.",
  },
  expired: {
    tone: "warning",
    title: "This link has expired",
    body: "Confirmation links last 24 hours. Sign in and ask for a new one from your dashboard.",
  },
  invalid: {
    tone: "warning",
    title: "This link is incomplete",
    body: "The address you landed on carried no confirmation token. Open the Confirm button in the email again, or sign in and ask for a new link.",
  },
};

export function VerifiedNotice({
  status,
  signedIn,
}: {
  status: VerifiedStatus;
  signedIn: boolean;
}) {
  const copy = COPY[status];
  const Icon =
    copy.tone === "success" ? CheckCircle : copy.tone === "warning" ? Warning : Info;

  return (
    <div
      role="status"
      className={`mb-4 rounded-2xl border p-5 ${TONE_CLASS[copy.tone]}`}
    >
      <div className="flex gap-3">
        <Icon
          weight="fill"
          aria-hidden="true"
          className={`mt-0.5 h-5 w-5 shrink-0 ${ICON_CLASS[copy.tone]}`}
        />
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-white">{copy.title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-neutral-400">
            {copy.body}
          </p>

          {/* Registration signs the user in before the mail can arrive, so the
              common reader of this notice already has a session. Telling them
              to "sign in below" would be a dead end; give them the door. */}
          {signedIn ? (
            <Link
              href="/dashboard"
              className="mt-3 inline-flex items-center rounded-lg bg-white px-3.5 py-2 text-xs font-semibold text-black transition-colors hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-black"
            >
              Go to your dashboard
            </Link>
          ) : (
            <p className="mt-2 text-xs text-neutral-500">
              Sign in below to carry on.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
