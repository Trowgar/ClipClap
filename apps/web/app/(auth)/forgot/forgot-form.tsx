"use client";

import { useState } from "react";
import Link from "next/link";
import { EnvelopeSimple } from "@phosphor-icons/react";
import {
  authInputClass,
  authPrimaryButtonClass,
  authSecondaryButtonClass,
} from "@/components/auth-shell";

export function ForgotForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim() || loading) return;
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });

      // The only thing this page is allowed to branch on. A 400 means the
      // string is not shaped like an address at all, which is decidable
      // offline and therefore discloses nothing; every other outcome - found,
      // not found, Google-only account, mail provider down - is one 200 and
      // one confirmation. /api/auth/forgot goes to real trouble not to be a
      // membership oracle, and a page that said "no account with that address"
      // would hand back exactly what the route refuses to give.
      if (res.status === 400) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "That does not look like an email address");
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError("Something went wrong. Try again in a moment.");
        setLoading(false);
        return;
      }

      setSentTo(email.trim());
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  };

  if (sentTo) {
    return (
      <div role="status">
        <div className="flex justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.06]">
            <EnvelopeSimple
              className="h-5 w-5 text-neutral-300"
              aria-hidden="true"
            />
          </span>
        </div>

        <h1 className="mt-4 text-center text-xl font-semibold text-white">
          Check your inbox
        </h1>
        <p className="mt-2 text-center text-sm leading-relaxed text-neutral-400">
          If there is a ClipClap account for{" "}
          <span className="text-neutral-200">{sentTo}</span> with a password on
          it, a reset link is on its way. It works for one hour and can be used
          once.
        </p>
        <p className="mt-3 text-center text-xs leading-relaxed text-neutral-600">
          Nothing arrives for accounts that sign in with Google or Telegram -
          there is no password on those to reset. Use that button on the sign-in
          page instead.
        </p>

        <div className="mt-6 space-y-3">
          <Link href="/login" className={authSecondaryButtonClass}>
            Back to sign in
          </Link>
          <button
            type="button"
            onClick={() => setSentTo(null)}
            className="w-full rounded text-center text-xs text-neutral-600 transition-colors hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            Use a different address
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1 className="text-center text-xl font-semibold text-white">
        Reset your password
      </h1>
      <p className="mt-1.5 text-center text-sm text-neutral-500">
        We will email you a link to set a new one.
      </p>

      <div className="mt-6">
        <label htmlFor="forgot-email" className="sr-only">
          Email address
        </label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={authInputClass}
          autoFocus
          required
        />

        {error && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!email.trim() || loading}
          className={`mt-3 ${authPrimaryButtonClass}`}
        >
          {loading ? "Sending..." : "Send reset link"}
        </button>
      </div>

      <p className="mt-5 text-center text-xs text-neutral-600">
        <Link
          href="/login"
          className="rounded underline-offset-2 transition-colors hover:text-neutral-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
