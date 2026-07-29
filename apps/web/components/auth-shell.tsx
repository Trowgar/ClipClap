import Link from "next/link";
import { Logo } from "@/components/logo";

/**
 * The three shapes every auth page shares, in one place.
 *
 * /login, /forgot and /reset were written at different times and are read one
 * after the other by the same person in the same minute - a password reset is
 * login -> forgot -> mail -> reset -> login. Divergent field styling reads as
 * "this is a different site" at exactly the moment the user is deciding whether
 * to trust the form with a new password.
 *
 * The focus-visible rings are not decoration. The original login inputs only
 * moved a border colour on :focus, which a keyboard user cannot see against a
 * black card at 8% white.
 */
export const authInputClass =
  "w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 outline-none transition-colors focus:border-white/20 focus-visible:ring-2 focus-visible:ring-white/25";

export const authPrimaryButtonClass =
  "w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-black disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98]";

export const authSecondaryButtonClass =
  "w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-center text-sm font-medium text-white transition-all hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-2 focus-visible:ring-offset-black active:scale-[0.98]";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-black px-6 py-12">
      {/* Background glow */}
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-[400px] w-[500px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.02] blur-[100px]" />

      <div className="relative w-full max-w-[380px]">
        <div className="mb-8 flex justify-center">
          <Link href="/" className="flex items-center" aria-label="ClipClap home">
            <Logo className="h-7" />
          </Link>
        </div>

        {children}

        <p className="mt-6 text-center text-xs text-neutral-700">
          <Link href="/" className="transition-colors hover:text-neutral-400">
            &larr; Back to ClipClap
          </Link>
        </p>
      </div>
    </div>
  );
}

export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-8">
      {children}
    </div>
  );
}
