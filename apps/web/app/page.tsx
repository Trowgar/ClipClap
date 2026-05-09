"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, ArrowDown, Play, Check, Send, Zap } from "lucide-react";

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
    price: "$3",
    period: "/week",
    features: [
      "75 min / week",
      "20 clips stored",
      "7-day retention",
      "TikTok subtitles",
    ],
    cta: "Get Starter",
    popular: false,
  },
  {
    name: "Plus",
    price: "$29",
    period: "/month",
    features: [
      "1,000 min / month",
      "150 clips stored",
      "30-day retention",
      "3 subtitle styles",
    ],
    cta: "Get Plus",
    popular: true,
  },
  {
    name: "Max",
    price: "$89",
    period: "/month",
    features: [
      "3,500 min / month",
      "1,000 clips stored",
      "90-day retention",
      "All styles",
      "Priority processing",
    ],
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
      className="relative flex-shrink-0"
      style={{ marginTop: clip.offset }}
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
        <div className="w-[120px] sm:w-[150px] h-[213px] sm:h-[267px] rounded-[20px] border border-white/[0.08] overflow-hidden relative shadow-2xl shadow-black/60 group">
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
              <Play className="w-3.5 h-3.5 text-white fill-white ml-0.5" />
            </div>
          </div>

          {/* Subtitle */}
          <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/80 via-black/30 to-transparent pt-14">
            <p className="text-white text-[10px] sm:text-[11px] font-extrabold text-center leading-tight whitespace-pre-line drop-shadow-[0_2px_4px_rgba(0,0,0,0.8)]">
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

function TelegramMock() {
  return (
    <div className="w-full max-w-[360px] mx-auto">
      {/* Phone shell */}
      <div className="rounded-[28px] border border-white/[0.08] bg-[#0e0e0e] overflow-hidden shadow-2xl shadow-black/60">
        {/* Telegram header */}
        <div className="bg-[#0e0e0e] border-b border-white/[0.06] px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-[#2AABEE] flex items-center justify-center flex-shrink-0">
            <svg
              viewBox="0 0 24 24"
              className="w-5 h-5 text-white fill-white"
            >
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z" />
            </svg>
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
                              <Play className="w-2.5 h-2.5 text-white/60 fill-white/60" />
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
          <div className="w-8 h-8 rounded-full bg-[#2AABEE] flex items-center justify-center flex-shrink-0">
            <Send className="w-3.5 h-3.5 text-white ml-[-1px]" />
          </div>
        </div>
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
          <Link href="/" className="flex items-center gap-2.5">
            <svg viewBox="0 0 32 32" fill="none" className="w-7 h-7">
              <rect width="32" height="32" rx="8" fill="white" />
              <rect x="8" y="7" width="10" height="18" rx="2.5" fill="none" stroke="black" strokeWidth="2" />
              <rect x="14" y="7" width="10" height="18" rx="2.5" fill="black" />
              <polygon points="18,13.5 18,18.5 21.5,16" fill="white" />
            </svg>
            <span className="text-[15px] font-semibold tracking-tight text-white">
              ClipClap
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-neutral-400 hover:text-white transition-colors"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-black transition-all hover:bg-neutral-200 active:scale-[0.97]"
            >
              Get Started
            </Link>
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
          {/* Pill badge */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-3.5 py-1.5 mb-6"
          >
            <Zap className="w-3.5 h-3.5 text-white" />
            <span className="text-xs font-medium text-neutral-300">
              Post 10× more clips
            </span>
          </motion.div>

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
                    <Play className="w-6 h-6 text-white fill-white ml-0.5" />
                  </div>
                </div>
                <div className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent flex items-end justify-between">
                  <div>
                    <p className="text-white text-xs font-medium">
                      The Rock Kicks Off The Podcast! — What Now? with Trevor Noah
                    </p>
                    <p className="text-neutral-400 text-[10px] mt-0.5">
                      1h 47min · Spotify
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
              <div className="flex items-center justify-center gap-3 sm:gap-4">
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
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-[#2AABEE]"
                  >
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z" />
                  </svg>
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
                  {" "}— get clips with subtitles sent back to you. No app needed.
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
                  <svg
                    viewBox="0 0 24 24"
                    className="w-4 h-4 fill-white"
                  >
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z" />
                  </svg>
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
              Start lean, top up when needed, upgrade when volume becomes routine.
            </p>
          </FadeIn>

          <div className="mt-14 grid gap-4 sm:grid-cols-3">
            {plans.map((plan, i) => (
              <FadeIn key={plan.name} delay={i * 0.08}>
                <div
                  className={`relative rounded-2xl border p-6 transition-colors ${
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
                  <h3 className="font-semibold text-white text-center">
                    {plan.name}
                  </h3>
                  <p className="mt-3 text-center">
                    <span className="text-3xl font-bold text-white tabular-nums">
                      {plan.price}
                    </span>
                    <span className="text-sm text-neutral-600">
                      {plan.period}
                    </span>
                  </p>
                  <ul className="mt-5 space-y-2.5 text-sm text-neutral-400">
                    {plan.features.map((f) => (
                      <li
                        key={f}
                        className="flex items-center gap-2 justify-center"
                      >
                        <Check className="w-3.5 h-3.5 text-neutral-600 flex-shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/login"
                    className={`mt-6 block rounded-lg px-4 py-2.5 text-sm font-medium text-center transition-all ${
                      plan.popular
                        ? "bg-white text-black hover:bg-neutral-200"
                        : "bg-white/[0.06] text-white hover:bg-white/[0.1]"
                    }`}
                  >
                    {plan.cta}
                  </Link>
                </div>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/[0.04] px-6 py-8">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 32 32" fill="none" className="w-5 h-5">
              <rect width="32" height="32" rx="8" fill="white" />
              <rect x="8" y="7" width="10" height="18" rx="2.5" fill="none" stroke="black" strokeWidth="2" />
              <rect x="14" y="7" width="10" height="18" rx="2.5" fill="black" />
              <polygon points="18,13.5 18,18.5 21.5,16" fill="white" />
            </svg>
            <span className="text-sm text-neutral-600 font-medium">
              ClipClap
            </span>
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
