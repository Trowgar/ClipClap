"use client";

import { useState, useCallback } from "react";
import { signIn } from "next-auth/react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { ArrowLeft, Play } from "lucide-react";

type Step = "start" | "login" | "register";

export default function LoginPage() {
  const [step, setStep] = useState<Step>("start");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleEmailSubmit = useCallback(async () => {
    if (!email) return;
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/check-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();

      if (data.exists && data.hasPassword) {
        setStep("login");
      } else if (data.exists && !data.hasPassword) {
        // User exists via Google OAuth, no password set
        setError("This email is linked to Google. Use Google sign-in.");
      } else {
        setStep("register");
      }
    } catch {
      setStep("register");
    } finally {
      setLoading(false);
    }
  }, [email]);

  const handleLogin = useCallback(async () => {
    setError("");
    setLoading(true);

    const res = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (res?.error) {
      setError("Wrong password. Try again.");
      setLoading(false);
    } else {
      window.location.href = "/dashboard";
    }
  }, [email, password]);

  const handleRegister = useCallback(async () => {
    if (!name.trim()) {
      setError("Enter your name");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setError("");
    setLoading(true);

    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || "Something went wrong");
      setLoading(false);
      return;
    }

    // Auto sign in after register
    const signInRes = await signIn("credentials", {
      email,
      password,
      redirect: false,
    });

    if (signInRes?.error) {
      setError("Account created but could not sign in. Try logging in.");
      setLoading(false);
    } else {
      window.location.href = "/dashboard";
    }
  }, [email, name, password, confirmPassword]);

  const handleGoogleSignIn = () => {
    signIn("google", { callbackUrl: "/dashboard" });
  };

  const goBack = () => {
    setStep("start");
    setPassword("");
    setConfirmPassword("");
    setName("");
    setError("");
  };

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-6">
      {/* Background glow */}
      <div className="absolute top-1/3 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[400px] bg-white/[0.02] rounded-full blur-[100px] pointer-events-none" />

      <div className="relative w-full max-w-[380px]">
        {/* Logo */}
        <div className="flex justify-center mb-8">
          <Link href="/" className="flex items-center gap-2.5">
            <svg viewBox="0 0 32 32" fill="none" className="w-8 h-8">
              <rect width="32" height="32" rx="8" fill="white" />
              <rect x="8" y="7" width="10" height="18" rx="2.5" fill="none" stroke="black" strokeWidth="2" />
              <rect x="14" y="7" width="10" height="18" rx="2.5" fill="black" />
              <polygon points="18,13.5 18,18.5 21.5,16" fill="white" />
            </svg>
            <span className="text-lg font-semibold text-white tracking-tight">
              ClipClap
            </span>
          </Link>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-8">
          <AnimatePresence mode="wait">
            {/* ── Start: email + google ── */}
            {step === "start" && (
              <motion.div
                key="start"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
              >
                <h1 className="text-xl font-semibold text-white text-center">
                  Welcome
                </h1>
                <p className="mt-1.5 text-sm text-neutral-500 text-center">
                  Sign in or create an account
                </p>

                {/* Email input */}
                <div className="mt-6">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleEmailSubmit()}
                    placeholder="you@example.com"
                    className="w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-white/20 transition-colors"
                    autoFocus
                  />
                  {error && step === "start" && (
                    <motion.p
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm text-red-400 mt-2"
                    >
                      {error}
                    </motion.p>
                  )}
                  <button
                    onClick={handleEmailSubmit}
                    disabled={!email || loading}
                    className="mt-3 w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {loading ? "..." : "Continue with Email"}
                  </button>
                </div>

                {/* Divider */}
                <div className="my-6 flex items-center gap-3">
                  <div className="flex-1 h-px bg-white/[0.06]" />
                  <span className="text-xs text-neutral-600">or</span>
                  <div className="flex-1 h-px bg-white/[0.06]" />
                </div>

                {/* Google */}
                <button
                  onClick={handleGoogleSignIn}
                  className="w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-white transition-all hover:bg-white/[0.08] active:scale-[0.98] flex items-center justify-center gap-3"
                >
                  <svg viewBox="0 0 24 24" className="w-4 h-4">
                    <path
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                      fill="#4285F4"
                    />
                    <path
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                      fill="#34A853"
                    />
                    <path
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                      fill="#FBBC05"
                    />
                    <path
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                      fill="#EA4335"
                    />
                  </svg>
                  Continue with Google
                </button>
              </motion.div>
            )}

            {/* ── Login: password ── */}
            {step === "login" && (
              <motion.div
                key="login"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
              >
                <button
                  onClick={goBack}
                  className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-white transition-colors mb-5"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back
                </button>

                <h1 className="text-xl font-semibold text-white">
                  Welcome back
                </h1>
                <p className="mt-1 text-sm text-neutral-500">
                  {email}
                </p>

                <div className="mt-6 space-y-3">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                    placeholder="Password"
                    className="w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-white/20 transition-colors"
                    autoFocus
                  />

                  {error && (
                    <motion.p
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm text-red-400"
                    >
                      {error}
                    </motion.p>
                  )}

                  <button
                    onClick={handleLogin}
                    disabled={!password || loading}
                    className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {loading ? "Signing in..." : "Sign in"}
                  </button>
                </div>
              </motion.div>
            )}

            {/* ── Register: name + password ── */}
            {step === "register" && (
              <motion.div
                key="register"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
              >
                <button
                  onClick={goBack}
                  className="flex items-center gap-1.5 text-sm text-neutral-500 hover:text-white transition-colors mb-5"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back
                </button>

                <h1 className="text-xl font-semibold text-white">
                  Create account
                </h1>
                <p className="mt-1 text-sm text-neutral-500">
                  {email}
                </p>

                <div className="mt-6 space-y-3">
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    className="w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-white/20 transition-colors"
                    autoFocus
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Password (min 6 characters)"
                    className="w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-white/20 transition-colors"
                  />
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                    placeholder="Repeat password"
                    className="w-full rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2.5 text-sm text-white placeholder:text-neutral-600 outline-none focus:border-white/20 transition-colors"
                  />

                  {error && (
                    <motion.p
                      initial={{ opacity: 0, y: -4 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm text-red-400"
                    >
                      {error}
                    </motion.p>
                  )}

                  <button
                    onClick={handleRegister}
                    disabled={loading}
                    className="w-full rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-black transition-all hover:bg-neutral-200 disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {loading ? "Creating account..." : "Create account"}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer link */}
        <p className="mt-6 text-center text-xs text-neutral-700">
          <Link href="/" className="hover:text-neutral-400 transition-colors">
            &larr; Back to ClipClap
          </Link>
        </p>
      </div>
    </div>
  );
}
