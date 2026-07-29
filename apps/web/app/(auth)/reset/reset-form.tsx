"use client";

import { useState } from "react";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import {
  authInputClass,
  authPrimaryButtonClass,
  authSecondaryButtonClass,
} from "@/components/auth-shell";

const MIN_PASSWORD_LENGTH = 6;

export function ResetForm({
  token,
  signedIn,
}: {
  token: string | null;
  signedIn: boolean;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  // No token in the URL at all. Its own state rather than a submit-time error:
  // there is nothing on this screen worth filling in, and a form that only
  // fails after you have typed a password twice is a worse way to say so.
  if (!token) {
    return (
      <div role="alert">
        <div className="flex justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500/10">
            <Warning
              weight="fill"
              className="h-5 w-5 text-amber-400"
              aria-hidden="true"
            />
          </span>
        </div>
        <h1 className="mt-4 text-center text-xl font-semibold text-white">
          This link is incomplete
        </h1>
        <p className="mt-2 text-center text-sm leading-relaxed text-neutral-400">
          The address you landed on carried no reset token. Mail clients
          sometimes cut long links in half - open the button in the email again,
          or ask for a fresh link.
        </p>
        <div className="mt-6 space-y-3">
          <Link href="/forgot" className={authSecondaryButtonClass}>
            Send me a new link
          </Link>
        </div>
      </div>
    );
  }

  if (done) {
    return (
      <div role="status">
        <div className="flex justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500/10">
            <CheckCircle
              weight="fill"
              className="h-5 w-5 text-emerald-400"
              aria-hidden="true"
            />
          </span>
        </div>
        <h1 className="mt-4 text-center text-xl font-semibold text-white">
          Password updated
        </h1>
        <p className="mt-2 text-center text-sm leading-relaxed text-neutral-400">
          Sign in with your new password. Redeeming the link also confirmed your
          email address, so your free minutes are unlocked.
        </p>
        <div className="mt-6">
          <Link href="/login" className={authPrimaryButtonClass}>
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  const submit = async () => {
    if (loading) return;
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Something went wrong. Try again.");
        setLoading(false);
        return;
      }

      // Drop whatever session this browser was holding before showing the
      // success card. Registration signs a user in automatically, so someone
      // can easily arrive here still logged in as the account they are
      // resetting - and the session is a JWT the API cannot revoke. Leaving it
      // in place would mean the person never has to type the password they
      // just set, and would not find out until the next device that it is not
      // the one they think it is. Failures are swallowed: the password IS
      // changed by this point and a stale cookie must not be reported as the
      // reset having failed.
      await signOut({ redirect: false }).catch(() => undefined);

      setDone(true);
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h1 className="text-center text-xl font-semibold text-white">
        Set a new password
      </h1>
      <p className="mt-1.5 text-center text-sm text-neutral-500">
        This link works once, and only for the next hour.
      </p>

      {signedIn && (
        <p className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs leading-relaxed text-neutral-400">
          You are signed in on this device. Setting a new password will sign you
          out here so you can check it works.
        </p>
      )}

      <div className="mt-6 space-y-3">
        <div>
          <label
            htmlFor="reset-password"
            className="mb-1.5 block text-xs text-neutral-500"
          >
            New password
          </label>
          <input
            id="reset-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            className={authInputClass}
            autoFocus
            required
            minLength={MIN_PASSWORD_LENGTH}
          />
        </div>

        <div>
          <label
            htmlFor="reset-confirm"
            className="mb-1.5 block text-xs text-neutral-500"
          >
            Repeat password
          </label>
          <input
            id="reset-confirm"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Repeat password"
            className={authInputClass}
            required
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !password || !confirm}
          className={authPrimaryButtonClass}
        >
          {loading ? "Saving..." : "Set new password"}
        </button>
      </div>

      <p className="mt-5 text-center text-xs text-neutral-600">
        Link expired?{" "}
        <Link
          href="/forgot"
          className="rounded underline-offset-2 transition-colors hover:text-neutral-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          Ask for a new one
        </Link>
      </p>
    </form>
  );
}
