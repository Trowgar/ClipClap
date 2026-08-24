"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, ArrowDown, Play, Check, Handshake } from "@phosphor-icons/react";
import { Logo } from "@/components/logo";

/* ────────────────────────────────────────────
   Data
   ──────────────────────────────────────────── */

const outputClips = [
  { img: "/clips/clip-1.png", subtitle: "This changed\neverything", time: "0:42", rotation: -8, offset: 24 },
  { img: "/clips/clip-2.png", subtitle: "Nobody\ntells you this", time: "1:17", rotation: -3, offset: 4 },
  { img: "/clips/clip-3.png", subtitle: "Wait wait wait\nhold on...", time: "1:48", rotation: 3, offset: 4 },
  { img: "/clips/clip-4.png", subtitle: "That's the\ncraziest part", time: "2:03", rotation: 8, offset: 24 },
];

const plans = [
  {
    name: "Starter",
    cycles: [
      { key: "weekly", label: "Weekly", price: "$3", period: "/week", minutes: "75 min / week" },
      { key: "monthly", label: "Monthly", price: "$9", period: "/month", minutes: "270 min / month" },
    ],
    features: ["20 clips stored", "7-day retention", "TikTok subtitles"],
    cta: "Get Starter",
    popular: false,
  },
  {
    name: "Plus",
    cycles: [
      { key: "monthly", label: "Monthly", price: "$29", period: "/month", minutes: "1,000 min / month" },
    ],
    features: ["150 clips stored", "30-day retention", "2 jobs at once"],
    cta: "Get Plus",
    popular: true,
  },
  {
    name: "Max",
    cycles: [
      { key: "monthly", label: "Monthly", price: "$89", period: "/month", minutes: "3,500 min / month" },
    ],
    features: ["1,000 clips stored", "90-day retention", "3 jobs at once", "Priority processing"],
    cta: "Get Max",
    popular: false,
  },
];

/* ────────────────────────────────────────────
   Telegram chat messages
   ──────────────────────────────────────────── */

const chatMessages: {
  from: "user" | "bot";
  text?: string;
  type?: "link" | "processing" | "clips";
}[] = [
  { from: "user", text: "https://youtube.com/watch?v=dQw4w...", type: "link" },
  { from: "bot", text: "Got it! Downloading video (2h 14m)..." },
  { from: "bot", text: "Transcribing audio..." },
  { from: "bot", text: "Found 4 highlights. Cutting clips..." },
  { from: "bot", type: "clips" },
];

/* ────────────────────────────────────────────
   Sub-components
   ──────────────────────────────────────────── */

function FadeIn({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-60px" }}
      transition={{ duration: 0.5, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* Editorial signal bar above the hero headline.
   Replaces the generic pill badge. Mono, no capsule — the pipeline
   verbs light up in sequence so the engine reads as "running". */
const PIPELINE_STEPS = ["detected", "cut", "captioned"];

function PipelineSignal() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const id = setInterval(
      () => setActive((i) => (i + 1) % PIPELINE_STEPS.length),
      1100,
    );
    return () => clearInterval(id);
  }, []);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="inline-flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 mb-6 font-mono text-[11px] sm:text-xs"
    >
      {/* Softly pulsing status dot — neutral, not a status-green */}
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full rounded-full bg-white/50 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-white/90" />
      </span>

      <span className="uppercase tracking-[0.18em] text-neutral-300">
        From long-form to shorts
      </span>

      {/* Pipeline trace — hidden on the narrowest screens to avoid wrapping */}
      <span className="hidden items-center gap-2.5 sm:flex">
        <span className="text-neutral-700">/</span>
        <span className="flex items-center gap-1.5 tracking-wide">
          {PIPELINE_STEPS.map((step, i) => (
            <span key={step} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-neutral-700">&rarr;</span>}
              <span
                className={`transition-colors duration-500 ${
                  active === i ? "text-neutral-200" : "text-neutral-600"
                }`}
              >
                {step}
              </span>
            </span>
          ))}
        </span>
      </span>
    </motion.div>
  );
}

function ClipCard({
  clip,
  index,
}: {
  clip: (typeof outputClips)[0];
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 60, rotate: 0 }}
      animate={{ opacity: 1, y: 0, rotate: clip.rotation }}
      transition={{
        delay: 1.0 + index * 0.1,
        duration: 0.8,
        ease: [0.22, 1, 0.36, 1],
      }}
      /* On phones the gap is fluid so the four cards plus the bleed from their
         rotation always fit the viewport; from md up it is the container's gap. */
      className={`relative flex-shrink-0 ${index > 0 ? "ml-[min(2.2vw,16px)] md:ml-0" : ""}`}
      style={{ marginTop: clip.offset, zIndex: index === 1 || index === 2 ? 20 : 10 }}
    >
      <motion.div
        animate={{ y: [0, -8, 0] }}
        transition={{
          duration: 4 + index * 0.4,
          repeat: Infinity,
          ease: "easeInOut",
          delay: index * 0.5,
        }}
      >
        <div className="w-[min(20vw,150px)] md:w-[150px] aspect-[9/16] rounded-[20px] border border-white/[0.08] overflow-hidden relative shadow-2xl shadow-black/60 group">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={clip.img}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-black/10" />

          {/* Play button */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-9 h-9 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity">
              <Play weight="fill" className="w-3.5 h-3.5 text-white fill-white ml-0.5" />
            </div>
          </div>

          {/* Subtitle */}
          <div className="absolute bottom-0 left-0 right-0 p-2 sm:p-3 bg-gradient-to-t from-black/80 via-black/30 to-transparent pt-10 sm:pt-14">
            <p className="text-white text-[9px] sm:text-[11px] font-extrabold text-center leading-tight whitespace-pre-line drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
              {clip.subtitle}
            </p>
          </div>

          {/* Time badge */}
          <div className="absolute top-2.5 right-2.5">
            <span className="text-[8px] sm:text-[9px] font-mono text-white/70 bg-black/40 backdrop-blur-sm rounded px-1.5 py-0.5">
              {clip.time}
            </span>
          </div>

          {/* Progress bar */}
          <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/10">
            <div
              className="h-full bg-white/50 rounded-full"
              style={{ width: `${25 + index * 18}%` }}
            />
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ── Telegram mock ── */

/* Single source for the Telegram paper-plane glyph (clean plane, no enclosing
   circle). Color and size are controlled via `className` on the <svg> (fill-*). */
function TelegramPlane({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z" />
    </svg>
  );
}

function TelegramMock() {
  return (
    <div className="w-full max-w-[360px] mx-auto">
      {/* Phone shell */}
      <div className="rounded-[28px] border border-white/[0.08] bg-[#0e0e0e] overflow-hidden shadow-2xl shadow-black/60">
        {/* Telegram header */}
        <div className="bg-[#0e0e0e] border-b border-white/[0.06] px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center flex-shrink-0">
            <TelegramPlane className="w-[18px] h-[18px] fill-neutral-200" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-semibold truncate">
              ClipClap Bot
            </p>
            <p className="text-[11px] text-neutral-500">@clipclapio_bot</p>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-1 h-1 rounded-full bg-emerald-500" />
            <span className="text-[10px] text-emerald-500/80">online</span>
          </div>
        </div>

        {/* Chat body */}
        <div className="bg-[#0e0e0e] px-3 py-4 space-y-2.5 min-h-[320px]">
          {chatMessages.map((msg, i) => {
            if (msg.type === "clips") {
              return (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.15 * i, duration: 0.4 }}
                  className="flex justify-start"
                >
                  <div className="rounded-2xl rounded-bl-md bg-[#1a1a1a] border border-white/[0.06] px-3 py-2.5 max-w-[85%]">
                    <p className="text-[12px] text-white mb-2">
                      Done! Here are your clips:
                    </p>
                    <div className="flex gap-1.5">
                      {["/clips/clip-1.png", "/clips/clip-2.png", "/clips/clip-3.png", "/clips/clip-4.png"].map(
                        (img, j) => (
                          <div
                            key={j}
                            className="w-[52px] h-[92px] rounded-lg overflow-hidden relative border border-white/[0.06]"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={img}
                              alt=""
                              className="absolute inset-0 w-full h-full object-cover"
                            />
                            <div className="absolute inset-0 flex items-center justify-center">
                              <Play weight="fill" className="w-2.5 h-2.5 text-white/60 fill-white/60" />
                            </div>
                            <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-white/10">
                              <div
                                className="h-full bg-white/50"
                                style={{ width: `${40 + j * 15}%` }}
                              />
                            </div>
                          </div>
                        )
                      )}
                    </div>
                    <p className="text-[10px] text-neutral-600 mt-2">4 clips ready to download</p>
                  </div>
                </motion.div>
              );
            }

            const isUser = msg.from === "user";
            return (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 10 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.15 * i, duration: 0.4 }}
                className={`flex ${isUser ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`rounded-2xl px-3.5 py-2 max-w-[85%] ${
                    isUser
                      ? "bg-[#2AABEE] rounded-br-md"
                      : "bg-[#1a1a1a] border border-white/[0.06] rounded-bl-md"
                  }`}
                >
                  <p
                    className={`text-[12px] leading-relaxed ${
                      isUser ? "text-white" : "text-neutral-300"
                    } ${msg.type === "link" ? "font-mono text-[11px] break-all" : ""}`}
                  >
                    {msg.text}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Input bar */}
        <div className="bg-[#0e0e0e] border-t border-white/[0.06] px-3 py-2.5 flex items-center gap-2">
          <div className="flex-1 bg-[#1a1a1a] rounded-full px-4 py-2 border border-white/[0.06]">
            <p className="text-[12px] text-neutral-600">
              Paste a link or send a video...
            </p>
          </div>
          <div className="w-8 h-8 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center flex-shrink-0">
            <TelegramPlane className="w-[15px] h-[15px] fill-neutral-300" />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Pricing card ── */

type Plan = (typeof plans)[number];

function PlanCard({ plan }: { plan: Plan }) {
  const [cycle, setCycle] = useState(0);
  const active = plan.cycles[cycle];

  return (
    <div
      className={`relative flex h-full flex-col rounded-2xl border p-6 transition-colors ${
        plan.popular
          ? "border-white/20 bg-white/[0.03]"
          : "border-white/[0.06] bg-white/[0.01]"
      }`}
    >
      {plan.popular && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-white px-3 py-0.5 text-[11px] font-semibold text-black">
          Popular
        </span>
      )}
      <h3 className="text-center font-semibold text-white">{plan.name}</h3>

      {/* Billing cycle - a real control on Starter, a quiet caption on the
          monthly-only plans, so all three cards keep the same vertical rhythm */}
      <div className="mt-3 flex justify-center">
        {plan.cycles.length > 1 ? (
          <div className="inline-flex rounded-full border border-white/[0.08] bg-white/[0.03] p-0.5">
            {plan.cycles.map((c, i) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setCycle(i)}
                className={`relative rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
                  i === cycle ? "text-black" : "text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {i === cycle && (
                  <motion.span
                    layoutId={`${plan.name}-cycle-pill`}
                    className="absolute inset-0 rounded-full bg-white"
                    transition={{ type: "spring", bounce: 0.2, duration: 0.45 }}
                  />
                )}
                <span className="relative z-10">{c.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <span className="inline-flex items-center border border-transparent px-3 py-1 text-[11px] font-medium text-neutral-600">
            {active.label}
          </span>
        )}
      </div>

      <motion.p
        key={active.key}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
        className="mt-3 text-center"
      >
        <span className="text-3xl font-bold text-white tabular-nums">{active.price}</span>
        <span className="text-sm text-neutral-600">{active.period}</span>
      </motion.p>

      <ul className="mt-5 space-y-2.5 text-sm text-neutral-400">
        <li className="flex items-center justify-center gap-2">
          <Check className="w-3.5 h-3.5 flex-shrink-0 text-neutral-600" />
          {active.minutes}
        </li>
        {plan.features.map((f) => (
          <li key={f} className="flex items-center justify-center gap-2">
            <Check className="w-3.5 h-3.5 flex-shrink-0 text-neutral-600" />
            {f}
          </li>
        ))}
      </ul>

      <div className="mt-auto pt-6">
        <Link
          href="/login"
          className={`block rounded-lg px-4 py-2.5 text-center text-sm font-medium transition-all ${
            plan.popular
              ? "bg-white text-black hover:bg-neutral-200"
              : "bg-white/[0.06] text-white hover:bg-white/[0.1]"
          }`}
        >
          {plan.cta}
        </Link>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────
   Page
   ──────────────────────────────────────────── */

export default function LandingPage() {
  return (
    <div className="relative min-h-screen bg-black overflow-hidden">
      {/* ── Film grain overlay (global) ── */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[60] mix-blend-overlay"
        style={{
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.5 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>")`,
          opacity: 0.06,
        }}
      />

      {/* ── Nav ── */}
      <header className="sticky top-0 z-50 backdrop-blur-xl bg-black/80 border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-3.5">
          <Link href="/" className="flex items-center" aria-label="ClipClap home">
            <Logo className="h-6" />
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-neutral-400 hover:text-white transition-colors"
            >
              Sign in
            </Link>
            {/* Telegram first: measured 2026-08-20, bot arrivals activate at 90.3% against
                5.9% on the web signup, so the primary button sends people where the product
                actually works. Sign in stays for people who want the web app. */}
            <a
              href="https://t.me/clipclapio_bot"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-all hover:bg-neutral-200 active:scale-[0.97]"
            >
              <TelegramPlane className="w-3.5 h-3.5 fill-black" />
              Start free
            </a>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section id="about" className="relative scroll-mt-20 pt-12 sm:pt-16 pb-8">
        {/* Dot grid with radial fade */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle at center, rgba(255,255,255,0.08) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage:
              "radial-gradient(ellipse at center top, black 0%, transparent 70%)",
            WebkitMaskImage:
              "radial-gradient(ellipse at center top, black 0%, transparent 70%)",
          }}
        />

        {/* Animated breathing spotlight */}
        <motion.div
          aria-hidden
          animate={{
            opacity: [0.6, 1, 0.6],
            scale: [1, 1.08, 1],
          }}
          transition={{
            duration: 8,
            repeat: Infinity,
            ease: "easeInOut",
          }}
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[600px] bg-white/[0.03] rounded-full blur-[120px] pointer-events-none"
        />

        <div className="relative z-10 max-w-4xl mx-auto px-6 text-center">
          {/* Signal bar (replaces the old pill badge) */}
          <PipelineSignal />

          {/* Headline */}
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.08 }}
            className="text-3xl sm:text-5xl lg:text-[56px] font-bold tracking-[-0.04em] leading-[1.08]"
          >
            <span className="text-white">Stop scrubbing.</span>
            <br />
            <span className="text-neutral-500">Start clipping.</span>
          </motion.h1>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.12 }}
            className="mt-3 text-sm sm:text-[15px] text-neutral-400 max-w-lg mx-auto leading-relaxed"
          >
            Drop any stream, podcast, or VOD. AI finds the viral moments,
            cuts vertical clips with subtitles. Built for clippers.
          </motion.p>

          {/* Hero CTA. There was none here before - visitors read the headline and scrolled.
              Telegram leads because that is the path that converts (90.3% of bot arrivals run
              a job, against 5.9% of web signups, measured 2026-08-20). */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.16 }}
            className="mt-7 flex flex-col items-center gap-3 sm:flex-row sm:justify-center"
          >
            <a
              href="https://t.me/clipclapio_bot"
              target="_blank"
              rel="noopener noreferrer"
              // White, not Telegram blue: the same action is already a white button in the
              // header, and this page is monochrome everywhere else - grain, dot grid, every
              // other control. A saturated blue pill in the hero reads as a pasted-in widget.
              // The plane icon carries "this opens Telegram" without spending the only colour
              // on the page. The dedicated Telegram section further down keeps its blue button,
              // where the colour belongs to the whole block.
              className="group inline-flex items-center gap-2.5 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition-all hover:bg-neutral-200 hover:scale-[1.02] active:scale-[0.98]"
            >
              <TelegramPlane className="w-4 h-4 fill-black" />
              Start free in Telegram
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <Link
              href="/login"
              className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
            >
              or use the web app
            </Link>
          </motion.div>

          <p className="mt-3.5 text-xs text-neutral-400">
            First 40 minutes of source video are free - no card needed.
          </p>
        </div>

        {/* ── Visual Pipeline ── */}
        <div className="relative z-10 mt-10 sm:mt-12 max-w-5xl mx-auto px-6">
          <div className="flex flex-col items-center gap-0">
            {/* Step 1: Source video (16:9) */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                delay: 0.5,
                duration: 0.7,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="w-full max-w-2xl"
            >
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded-full border border-neutral-700 flex items-center justify-center text-[10px] font-mono text-neutral-500">
                  1
                </div>
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Your long video
                </span>
              </div>
              <div className="relative aspect-video rounded-xl border border-white/[0.08] overflow-hidden bg-neutral-950">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/clips/source-podcast.png"
                  alt="Source video"
                  className="absolute inset-0 w-full h-full object-cover"
                />
                <div className="absolute top-0 left-0 right-0 h-[8%] bg-gradient-to-b from-black/40 to-transparent" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-14 h-14 rounded-full bg-white/10 backdrop-blur-sm flex items-center justify-center border border-white/10 hover:bg-white/20 transition-colors cursor-pointer">
                    <Play weight="fill" className="w-6 h-6 text-white fill-white ml-0.5" />
                  </div>
                </div>
                <div className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent flex items-end justify-between">
                  <div>
                    <p className="text-white text-xs font-medium">
                      The Rock Kicks Off The Podcast! - What Now? with Trevor Noah
                    </p>
                    <p className="text-neutral-400 text-[10px] mt-0.5">
                      1h 47min · YouTube
                    </p>
                  </div>
                  <span className="text-[10px] font-mono text-neutral-500 bg-black/40 px-2 py-0.5 rounded">
                    16:9
                  </span>
                </div>
                <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/10">
                  <div className="h-full bg-white/30 w-[15%]" />
                </div>
              </div>
            </motion.div>

            {/* Arrow connector */}
            <motion.div
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.8, duration: 0.4 }}
              className="flex flex-col items-center py-5"
            >
              <div className="flex items-center gap-3">
                <div className="h-px w-8 bg-gradient-to-r from-transparent to-neutral-700" />
                <div className="flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-950 px-4 py-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                  <span className="text-[11px] font-medium text-neutral-400">
                    AI finds the best moments
                  </span>
                </div>
                <div className="h-px w-8 bg-gradient-to-l from-transparent to-neutral-700" />
              </div>
              <ArrowDown className="w-4 h-4 text-neutral-600 mt-3" />
            </motion.div>

            {/* Step 2: Output clips (9:16) */}
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                delay: 1.0,
                duration: 0.7,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="w-full max-w-2xl"
            >
              <div className="flex items-center gap-2 mb-3">
                <div className="w-5 h-5 rounded-full border border-neutral-700 flex items-center justify-center text-[10px] font-mono text-neutral-500">
                  2
                </div>
                <span className="text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Your clips with subtitles
                </span>
              </div>
              {/* -mx-3 lets the fan borrow the section's phone padding, which
                  buys the room for the gaps between the cards. */}
              <div className="flex items-center justify-center gap-0 md:gap-4 -mx-3 md:mx-0">
                {outputClips.map((clip, i) => (
                  <ClipCard key={i} clip={clip} index={i} />
                ))}
              </div>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 1.6 }}
                className="mt-3 flex items-center justify-center"
              >
                <span className="text-[11px] text-neutral-600">
                  9:16 vertical · subtitles burned in · ready to post
                </span>
              </motion.div>
            </motion.div>

            {/* Platforms */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 1.8, duration: 0.5 }}
              className="mt-12 flex flex-col items-center gap-5"
            >
              <span className="text-sm font-medium text-neutral-500 uppercase tracking-wider">
                Ready to post on
              </span>
              <div className="flex items-center gap-12">
                {/* TikTok */}
                <div className="flex items-center gap-2.5 text-neutral-500 hover:text-neutral-300 transition-colors">
                  <svg viewBox="0 0 24 24" className="w-7 h-7 fill-current">
                    <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.76a8.28 8.28 0 004.76 1.5v-3.4a4.85 4.85 0 01-1-.17z" />
                  </svg>
                  <span className="text-sm font-medium">TikTok</span>
                </div>
                {/* Instagram Reels */}
                <div className="flex items-center gap-2.5 text-neutral-500 hover:text-neutral-300 transition-colors">
                  <svg viewBox="0 0 24 24" className="w-7 h-7 fill-current">
                    <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
                  </svg>
                  <span className="text-sm font-medium">Reels</span>
                </div>
                {/* YouTube Shorts */}
                <div className="flex items-center gap-2.5 text-neutral-500 hover:text-neutral-300 transition-colors">
                  <svg viewBox="0 0 24 24" className="w-7 h-7 fill-current">
                    <path d="M10 15l5.19-3L10 9v6m11.56-7.83c.13.47.22 1.1.28 1.9.07.8.1 1.49.1 2.09L22 12c0 2.19-.16 3.8-.44 4.83-.25.9-.83 1.48-1.73 1.73-.47.13-1.33.22-2.65.28-1.3.07-2.49.1-3.59.1L12 19c-4.19 0-6.8-.16-7.83-.44-.9-.25-1.48-.83-1.73-1.73-.13-.47-.22-1.1-.28-1.9-.07-.8-.1-1.49-.1-2.09L2 12c0-2.19.16-3.8.44-4.83.25-.9.83-1.48 1.73-1.73.47-.13 1.33-.22 2.65-.28 1.3-.07 2.49-.1 3.59-.1L12 5c4.19 0 6.8.16 7.83.44.9.25 1.48.83 1.73 1.73z" />
                  </svg>
                  <span className="text-sm font-medium">Shorts</span>
                </div>
              </div>
            </motion.div>

          </div>
        </div>
      </section>

      {/* ── Telegram Bot Section ── */}
      <section id="telegram" className="scroll-mt-20 py-24 sm:py-32 border-t border-white/[0.04]">
        <div className="max-w-5xl mx-auto px-6">
          <div className="grid lg:grid-cols-2 gap-16 lg:gap-12 items-center">
            {/* Left: text */}
            <FadeIn>
              <div>
                <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 mb-6">
                  <TelegramPlane className="w-3.5 h-3.5 fill-neutral-300" />
                  <span className="text-xs font-medium text-neutral-400">
                    Telegram Bot
                  </span>
                </div>

                <h2 className="text-2xl sm:text-3xl lg:text-4xl font-bold tracking-[-0.03em] text-white leading-tight">
                  Clip videos right
                  <br />
                  from Telegram.
                </h2>

                <p className="mt-4 text-[15px] text-neutral-400 leading-relaxed max-w-md">
                  Send a link or upload a video to{" "}
                  <span className="text-white font-medium">@clipclapio_bot</span>
                  {" "}- get clips with subtitles sent back to you. No app needed.
                </p>

                <div className="mt-6 space-y-3">
                  {[
                    "Paste any YouTube, Twitch, or TikTok link",
                    "Or upload a video file directly",
                    "Get vertical clips with subtitles in minutes",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2.5">
                      <Check className="w-4 h-4 text-neutral-600 mt-0.5 flex-shrink-0" />
                      <span className="text-sm text-neutral-400">{item}</span>
                    </div>
                  ))}
                </div>

                <a
                  href="https://t.me/clipclapio_bot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group mt-8 inline-flex items-center gap-2.5 rounded-xl bg-[#2AABEE] px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-[#229ED9] hover:scale-[1.02] active:scale-[0.98]"
                >
                  <TelegramPlane className="w-4 h-4 fill-white" />
                  Open in Telegram
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                </a>
              </div>
            </FadeIn>

            {/* Right: Telegram mock */}
            <FadeIn delay={0.15}>
              <TelegramMock />
            </FadeIn>
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section id="pricing" className="scroll-mt-20 py-20 sm:py-28 border-t border-white/[0.04]">
        <div className="max-w-4xl mx-auto px-6">
          <FadeIn className="text-center">
            <h2 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Simple pricing
            </h2>
            <p className="mt-2 text-sm text-neutral-500">
              Start free, top up when needed, upgrade when volume becomes routine.
            </p>
          </FadeIn>

          {/* Free allowance - rendered in the page's own instrument language:
              a source-video timeline whose head fills up to the 60-minute
              mark. States exactly what FREE_TIER grants (plans.ts): 60
              lifetime source minutes on a new account, no card. */}
          <FadeIn delay={0.05}>
            <div className="mt-12 rounded-xl border border-white/[0.06] bg-white/[0.01] px-5 py-4 sm:px-6 sm:py-5">
              {/* Readout header */}
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em]">
                <span className="flex items-center gap-2 text-neutral-400">
                  <span className="relative flex h-1 w-1">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-white/50 animate-ping" />
                    <span className="relative inline-flex h-1 w-1 rounded-full bg-white/90" />
                  </span>
                  Free allowance
                </span>
                <span className="normal-case tracking-normal text-neutral-600">
                  no card required
                </span>
              </div>

              {/* Timeline - fills to the full 60-minute allowance on scroll */}
              <div className="mt-3">
                <div className="h-[3px] overflow-hidden rounded-full bg-white/10">
                  <motion.div
                    initial={{ width: 0 }}
                    whileInView={{ width: "100%" }}
                    viewport={{ once: true, margin: "-40px" }}
                    transition={{ duration: 1.4, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}
                    className="h-full rounded-full bg-white/40"
                  />
                </div>
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-neutral-600">
                  <span>00:00</span>
                  <span className="text-neutral-400">60:00 free</span>
                </div>
              </div>

              {/* Copy + quiet CTA - the only white button in this section stays on the Popular plan */}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm leading-relaxed text-neutral-400">
                  Your first{" "}
                  <span className="font-medium text-white">
                    40 minutes of source video
                  </span>{" "}
                  are free - one-time, on a new account.
                </p>
                <a
                  href="https://t.me/clipclapio_bot"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex flex-shrink-0 items-center gap-1.5 text-sm font-medium text-white transition-colors hover:text-neutral-300"
                >
                  Start free in Telegram
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </a>
              </div>
            </div>
          </FadeIn>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            {plans.map((plan, i) => (
              <FadeIn key={plan.name} delay={i * 0.08} className="h-full">
                <PlanCard plan={plan} />
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Affiliate ── */}
      <section
        id="affiliate"
        className="relative scroll-mt-20 overflow-hidden border-t border-white/[0.04] py-24 sm:py-32"
      >
        {/* Soft spotlight */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[760px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/[0.03] blur-[120px]"
        />

        <div className="relative mx-auto max-w-4xl px-6 text-center">
          <FadeIn>
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5">
              <Handshake className="h-3.5 w-3.5 text-white" />
              <span className="text-xs font-medium text-neutral-400">
                Affiliate Program
              </span>
            </div>

            <h2 className="text-2xl font-bold leading-[1.1] tracking-[-0.03em] sm:text-3xl lg:text-[44px]">
              <span className="text-white">Refer creators.</span>{" "}
              <span className="text-neutral-500">Earn 30% for life.</span>
            </h2>

            <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-neutral-400 sm:text-[15px]">
              Bring creators to ClipClap and earn{" "}
              <span className="font-medium text-white">
                30% from every successful payment
              </span>{" "}
              they make, for as long as they stay subscribed. No cap. No expiration.
            </p>
          </FadeIn>

          <FadeIn delay={0.1}>
            <div className="mt-12 grid gap-4 text-left sm:grid-cols-3">
              {[
                { stat: "30%", label: "Earn from every successful subscription payment." },
                { stat: "Lifetime", label: "Keep earning while your referral stays subscribed." },
                { stat: "On-demand", label: "Withdraw your balance anytime, $50 minimum." },
              ].map((h) => (
                <div
                  key={h.stat}
                  className="rounded-2xl border border-white/[0.06] bg-white/[0.01] p-5"
                >
                  <div className="text-2xl font-bold tracking-tight text-white">
                    {h.stat}
                  </div>
                  <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">
                    {h.label}
                  </p>
                </div>
              ))}
            </div>
          </FadeIn>

          {/* How it works */}
          <FadeIn delay={0.16}>
            <div className="mt-16">
              <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
                How it works
              </h3>
              <div className="mt-6 grid gap-4 text-left sm:grid-cols-4">
                {[
                  "Share your referral link.",
                  "A creator signs up and subscribes.",
                  "You earn 30% from every payment.",
                  "Withdraw anytime once your balance clears.",
                ].map((step, i) => (
                  <div
                    key={step}
                    className="rounded-2xl border border-white/[0.06] bg-white/[0.01] p-4"
                  >
                    <div className="flex h-6 w-6 items-center justify-center rounded-full border border-neutral-700 font-mono text-[11px] text-neutral-500">
                      {i + 1}
                    </div>
                    <p className="mt-3 text-sm leading-relaxed text-neutral-400">
                      {step}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>

          <FadeIn delay={0.22}>
            <div className="mt-12 flex flex-col items-center gap-3">
              <Link
                href="/login"
                className="group inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition-all hover:scale-[1.02] hover:bg-neutral-200 active:scale-[0.98]"
              >
                Join the affiliate program
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
              <p className="text-xs text-neutral-600">
                Free to join. Grab your referral link from the dashboard.
              </p>
              <p className="mx-auto mt-3 max-w-xl text-[11px] leading-relaxed text-neutral-700">
                Commission is calculated from net revenue after payment processing
                fees. Payouts are subject to anti-fraud review.
              </p>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.04] px-6 py-8">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center">
            <Logo className="h-4 opacity-60" />
          </div>
          <div className="flex items-center gap-6">
            <a
              href="https://t.me/clipclapio_bot"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
            >
              Telegram Bot
            </a>
            <Link
              href="/login"
              className="text-xs text-neutral-600 hover:text-neutral-400 transition-colors"
            >
              Sign in
            </Link>
            <span className="text-xs text-neutral-700">
              &copy; {new Date().getFullYear()}
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
