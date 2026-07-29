"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { EnvelopeSimple } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { resendVerificationEmail } from "@/app/(dashboard)/dashboard/actions";
import {
  dashboardPanelClass,
  dashboardPrimaryActionClass,
  dashboardSecondaryActionClass,
} from "@/components/panel-styles";

/** Date only, and pinned to en-GB rather than the reader's default locale.
 *  This component is server-rendered and then hydrated, and a date formatted
 *  with the server's locale on one pass and the browser's on the next is a
 *  hydration mismatch. The web UI is English-only anyway.
 *
 *  The time of day is left off: the question this answers is "was that recently
 *  enough that it might still arrive, or should I ask for another one". */
function sentOn(value: Date): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

/**
 * The account has no anchor, so it has no allowance at all - isTrialAnchored
 * wants a verified address, a linked Google row, or a Telegram id. Both ways of
 * getting one are on this panel, because the mail is the common path and the
 * one that can silently fail: an unverified account whose confirmation link
 * never arrived has no other route to its free minutes.
 */
export function VerifyEmailPanel({
  email,
  lifetimeMinutes,
  verificationSentAt,
}: {
  email: string | null;
  lifetimeMinutes: number;
  /** When a link was last accepted by the mail provider, or null if none ever
   *  was. Null is also what every account created before the column existed
   *  reads as, which is why the copy says "no record of" rather than "we did
   *  not send" - the second would be a new false claim replacing the old one. */
  verificationSentAt: Date | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<
    { kind: "ok" | "error"; text: string } | null
  >(null);

  const resend = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await resendVerificationEmail();
      if (result.ok) {
        setMessage({
          kind: "ok",
          text: `A new link is on its way${email ? ` to ${email}` : ""}. It works for 24 hours and can be used once.`,
        });
        // The send stamped verificationSentAt, so the paragraph above is now
        // out of date - it may still be showing "no record of a confirmation
        // link". Pull the server's copy so the two agree.
        router.refresh();
        return;
      }
      setMessage({ kind: "error", text: result.error });
      // The address was confirmed while this page sat open - a mail scanner
      // opening the link is enough. Pull fresh server state so the panel
      // replaces itself with the upload zone instead of arguing with the user.
      if (result.alreadyVerified) router.refresh();
    });
  };

  return (
    <section className={dashboardPanelClass} aria-labelledby="verify-email-title">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]">
          <EnvelopeSimple
            className="h-4 w-4 text-neutral-300"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="verify-email-title" className="text-base font-semibold text-white">
            Confirm your email to unlock your free minutes
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
            {lifetimeMinutes} minutes of video are waiting on this account - no
            card, no plan. We only need to know the address is yours.{" "}
            {verificationSentAt ? (
              <>
                We sent a link{email ? " to " : ""}
                {email && <span className="text-neutral-200">{email}</span>} on{" "}
                {sentOn(verificationSentAt)}.
              </>
            ) : (
              <span className="text-amber-400">
                We have no record of a confirmation link reaching
                {email ? " " : " you"}
                {email && <span className="text-amber-300">{email}</span>} - the
                send may have failed. Ask for one now.
              </span>
            )}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={resend}
              disabled={pending}
              className={dashboardPrimaryActionClass}
            >
              {pending ? "Sending..." : "Send me another link"}
            </button>
            <Link
              href="/dashboard/settings"
              className={dashboardSecondaryActionClass}
            >
              Connect Telegram instead
            </Link>
          </div>

          {message && (
            <p
              role="status"
              className={`mt-3 text-xs leading-relaxed ${
                message.kind === "ok" ? "text-emerald-400" : "text-amber-400"
              }`}
            >
              {message.text}
            </p>
          )}

          <p className="mt-3 text-xs leading-relaxed text-neutral-600">
            Already clicked Confirm? Reload this page. Connecting Telegram
            unlocks the same minutes without any email at all.
          </p>
        </div>
      </div>
    </section>
  );
}
