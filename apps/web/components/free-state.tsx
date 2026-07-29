import Link from "next/link";
import { CalendarBlank, Lightning, PaperPlaneTilt } from "@phosphor-icons/react/dist/ssr";
import {
  dashboardPanelClass,
  dashboardPrimaryActionClass,
  dashboardSecondaryActionClass,
} from "@/components/panel-styles";

/**
 * What the dashboard shows a free account instead of an upload form it knows
 * will be refused.
 *
 * The page used to render UploadZone unconditionally, under a comment claiming
 * "NONE now carries the free allowance rather than zeros". That was written for
 * a tier switched off in July: a new account got an enabled drop zone, picked a
 * file, and was told "Daily job limit reached (0)". A form that cannot succeed
 * is worse than no form - it spends the one moment of intent a new user has.
 *
 * Every panel here answers the same three questions in the same order: what is
 * true, why, and the one thing to do next.
 */

const BOT_URL = "https://t.me/clipclapio_bot";

/** The free allowance is spent, for good. Nothing on this screen can change
 *  that, so it does not pretend otherwise - it says what they still own and
 *  where the next clip comes from. */
export function FreeExhaustedPanel({
  remainingMinutes,
  lifetimeMinutes,
}: {
  remainingMinutes: number;
  lifetimeMinutes: number;
}) {
  return (
    <section className={dashboardPanelClass} aria-labelledby="free-exhausted-title">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]">
          <Lightning
            weight="fill"
            className="h-4 w-4 text-neutral-300"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0">
          <h2 id="free-exhausted-title" className="text-base font-semibold text-white">
            Your free minutes are used up
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
            {remainingMinutes < 1
              ? `All ${lifetimeMinutes} free minutes are spent.`
              : `${remainingMinutes} of your ${lifetimeMinutes} free minutes are left, which is not enough for another video.`}{" "}
            Every clip we already made for you stays in your library.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/dashboard/plans" className={dashboardPrimaryActionClass}>
              See plans
            </Link>
            <a
              href={BOT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={dashboardSecondaryActionClass}
            >
              <PaperPlaneTilt className="h-4 w-4 text-[#2AABEE]" aria-hidden="true" />
              Clip from Telegram
            </a>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-neutral-600">
            Starter is 3 USD a week for 75 minutes of video, sources up to 3
            hours, and 20 clips kept for 7 days. The Telegram bot runs on the
            same account and the same minutes - it is the phone-shaped way in,
            not a second allowance.
          </p>
        </div>
      </div>
    </section>
  );
}

/** The global monthly ceiling is spent. Nothing is wrong with THIS account, and
 *  the copy has to say whose limit it is or the user reads it as their own
 *  allowance being gone - the same distinction the bot's freeBudgetClosed
 *  string makes. */
export function FreePausedPanel({
  remainingMinutes,
  lifetimeMinutes,
}: {
  remainingMinutes: number;
  lifetimeMinutes: number;
}) {
  return (
    <section className={dashboardPanelClass} aria-labelledby="free-paused-title">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
          <CalendarBlank
            weight="fill"
            className="h-4 w-4 text-amber-400"
            aria-hidden="true"
          />
        </span>
        <div className="min-w-0">
          <h2 id="free-paused-title" className="text-base font-semibold text-white">
            Free runs are paused until the first of next month
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
            That is a limit on our side, not on your account.{" "}
            {remainingMinutes >= 1
              ? `Your ${remainingMinutes} of ${lifetimeMinutes} free minutes are still waiting for you.`
              : `Your free minutes are still on the account.`}{" "}
            Uploading now would only be refused, so the form is off rather than
            pretending.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/dashboard/plans" className={dashboardPrimaryActionClass}>
              Start clipping now - see plans
            </Link>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-neutral-600">
            Starter is 3 USD a week for 75 minutes of video and sources up to 3
            hours.
          </p>
        </div>
      </div>
    </section>
  );
}
