import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { prisma, referralService, REFERRAL_CONFIG } from "@clipfast/shared";
import {
  CalendarCheck,
  CurrencyDollarSimple,
  GlobeSimple,
  Handshake,
  Hourglass,
  Lightning,
  PaperPlaneTilt,
  SealCheck,
  ShieldCheck,
  UsersThree,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import { Badge } from "@/components/ui/badge";
import { CopyField } from "@/components/referrals/copy-field";
import { JoinAffiliate } from "@/components/referrals/join-affiliate";
import { PayoutForm } from "@/components/referrals/payout-form";

const RATE_PCT = REFERRAL_CONFIG.rateBps / 100;
const HOLD_DAYS = REFERRAL_CONFIG.holdDays;
const MIN_PAYOUT = REFERRAL_CONFIG.minPayoutUsd;
const PAYOUT_DAYS = REFERRAL_CONFIG.payoutDays.join(" & ");

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PERKS = [
  { icon: Lightning, label: `${RATE_PCT}% commission`, sub: "on every payment" },
  { icon: Handshake, label: "Lifetime", sub: "for as long as they stay" },
  { icon: Hourglass, label: `${HOLD_DAYS}-day hold`, sub: "clears refund window" },
  { icon: CalendarCheck, label: `Paid ${PAYOUT_DAYS}`, sub: `min ${money(MIN_PAYOUT)}` },
];

function planBadge(plan: string) {
  if (plan === "NONE")
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Free
      </Badge>
    );
  return <Badge variant="secondary">{plan}</Badge>;
}

function statusMeta(status: string) {
  switch (status) {
    case "ACTIVE":
      return { label: "Active", text: "text-emerald-400", dot: "bg-emerald-400" };
    case "DUNNING":
    case "CANCELED_GRACE":
      return { label: "At risk", text: "text-amber-400", dot: "bg-amber-400" };
    default:
      return { label: "Inactive", text: "text-muted-foreground", dot: "bg-muted-foreground" };
  }
}

export default async function ReferralsPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      referralCode: true,
      referralTermsAcceptedAt: true,
      payoutMethod: true,
      payoutDestination: true,
    },
  });

  const accepted = !!user?.referralTermsAcceptedAt;

  // ---------- Not yet joined: focused value-prop hero ----------
  if (!accepted) {
    return (
      <div className="mx-auto max-w-2xl">
        <div className="cc-reveal relative overflow-hidden rounded-2xl border border-border bg-card p-8 sm:p-12">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl"
          />
          <div className="relative">
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-muted-foreground">
              <Handshake weight="duotone" className="h-3.5 w-3.5 text-emerald-400" />
              Affiliate Program
            </div>
            <h1 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">
              Earn <span className="text-emerald-400">{RATE_PCT}%</span>
              <br />
              for life.
            </h1>
            <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">
              Share ClipClap on TikTok, YouTube, or anywhere your audience lives.
              Earn {RATE_PCT}% of every payment your referrals make - for as long as
              they stay subscribed.
            </p>

            <div className="mt-8 grid grid-cols-2 gap-3">
              {PERKS.map((p) => (
                <div
                  key={p.label}
                  className="flex items-start gap-3 rounded-lg border border-border bg-background/50 p-3"
                >
                  <p.icon weight="duotone" className="mt-0.5 h-5 w-5 text-emerald-400" />
                  <div>
                    <div className="text-sm font-medium">{p.label}</div>
                    <div className="text-xs text-muted-foreground">{p.sub}</div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-8">
              <JoinAffiliate />
              <p className="mt-3 text-xs text-muted-foreground">
                By joining you agree to the payout terms ({RATE_PCT}% of net payments,
                after fees) and anti-fraud rules.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Joined: full dashboard ----------
  const code = user?.referralCode ?? (await referralService.ensureReferralCode(userId));
  const balance = await referralService.getReferralBalance(userId);
  const referrals = await prisma.user.findMany({
    where: { referredById: userId },
    select: { id: true, createdAt: true, plan: true, subscriptionStatus: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "https://clipclap.io";
  const botName =
    process.env.TELEGRAM_BOT_USERNAME ?? process.env.NEXT_PUBLIC_BOT_NAME ?? "ClipClapBot";
  const webLink = `${appUrl.replace(/\/$/, "")}/?ref=${code}`;
  const tgLink = `https://t.me/${botName}?start=ref_${code}`;

  const progressPct = Math.min(100, Math.round((balance.availableUsd / MIN_PAYOUT) * 100));
  const readyToPay = balance.availableUsd >= MIN_PAYOUT;
  const toGo = Math.max(0, MIN_PAYOUT - balance.availableUsd);
  const activeCount = referrals.filter((r) => r.subscriptionStatus === "ACTIVE").length;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <div className="cc-reveal flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Affiliate Program</h1>
          <p className="text-sm text-muted-foreground">
            Share your link, earn {RATE_PCT}% of every referral&apos;s payments - for life.
          </p>
        </div>
        <Badge variant="secondary" className="hidden shrink-0 gap-1.5 py-1 sm:inline-flex">
          <Lightning weight="fill" className="h-3 w-3 text-emerald-400" />
          {RATE_PCT}% · lifetime
        </Badge>
      </div>

      {/* Hero: earnings */}
      <section
        className="cc-reveal relative overflow-hidden rounded-2xl border border-border bg-card p-6 sm:p-8"
        style={{ animationDelay: "60ms" }}
      >
        <div
          aria-hidden
          className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute -bottom-32 right-0 h-72 w-72 rounded-full bg-white/[0.03] blur-3xl"
        />
        <div className="relative">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            Available to withdraw
          </div>
          <div className="mt-2 flex items-end gap-3">
            <span className="text-5xl font-bold tabular-nums tracking-tight sm:text-6xl">
              {money(balance.availableUsd)}
            </span>
          </div>

          {/* Progress to minimum payout */}
          <div className="mt-5 max-w-md">
            <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-emerald-400 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {readyToPay ? (
                <span className="text-emerald-400">
                  Ready for the next payout ({PAYOUT_DAYS} of the month).
                </span>
              ) : (
                <>
                  {money(toGo)} to go until the {money(MIN_PAYOUT)} minimum payout.
                </>
              )}
            </p>
          </div>

          {/* Secondary stats */}
          <div className="mt-6 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border bg-border">
            {[
              { label: `In hold (${HOLD_DAYS}d)`, value: balance.pendingUsd },
              { label: "In payout", value: balance.payoutPendingUsd },
              { label: "Paid out (lifetime)", value: balance.paidUsd },
            ].map((s) => (
              <div key={s.label} className="bg-card px-4 py-3">
                <div className="text-[11px] text-muted-foreground">{s.label}</div>
                <div className="mt-0.5 text-lg font-semibold tabular-nums">
                  {money(s.value)}
                </div>
              </div>
            ))}
          </div>

          {!user?.payoutDestination && (
            <div className="mt-5 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-sm text-amber-300">
              <Warning weight="duotone" className="h-4 w-4 shrink-0" />
              Add your payout details below to start receiving payments.
            </div>
          )}
        </div>
      </section>

      {/* Perks strip */}
      <section
        className="cc-reveal grid grid-cols-2 gap-3 sm:grid-cols-4"
        style={{ animationDelay: "120ms" }}
      >
        {PERKS.map((p) => (
          <div key={p.label} className="rounded-xl border border-border bg-card p-4">
            <p.icon weight="duotone" className="h-5 w-5 text-muted-foreground" />
            <div className="mt-2 text-sm font-medium">{p.label}</div>
            <div className="text-xs text-muted-foreground">{p.sub}</div>
          </div>
        ))}
      </section>

      {/* Share */}
      <section
        className="cc-reveal rounded-2xl border border-border bg-card p-6"
        style={{ animationDelay: "180ms" }}
      >
        <div className="flex items-center gap-2">
          <PaperPlaneTilt weight="duotone" className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Share &amp; earn</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Both links carry your code - share whichever fits the platform.
        </p>

        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="shrink-0">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Your code
            </div>
            <div className="mt-1 font-mono text-3xl font-bold tracking-tight">{code}</div>
          </div>
          <div className="hidden h-12 w-px bg-border sm:block" />
          <div className="grid flex-1 gap-2.5">
            <CopyField
              label="Web link"
              value={webLink}
              icon={<GlobeSimple weight="duotone" className="h-4 w-4" />}
            />
            <CopyField
              label="Telegram link"
              value={tgLink}
              icon={<PaperPlaneTilt weight="duotone" className="h-4 w-4" />}
            />
          </div>
        </div>
      </section>

      {/* Payout settings */}
      <section
        className="cc-reveal rounded-2xl border border-border bg-card p-6"
        style={{ animationDelay: "240ms" }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CurrencyDollarSimple weight="duotone" className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Payout destination</h2>
          </div>
          {user?.payoutDestination ? (
            <Badge variant="secondary" className="gap-1.5">
              <SealCheck weight="fill" className="h-3 w-3 text-emerald-400" />
              {user.payoutMethod ?? "Set"}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-300">
              Not set
            </Badge>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Where we send your payouts. Network fees are deducted at withdrawal.
        </p>
        <div className="mt-4">
          <PayoutForm
            currentMethod={user?.payoutMethod ?? null}
            currentDestination={user?.payoutDestination ?? null}
          />
        </div>
      </section>

      {/* Referrals */}
      <section
        className="cc-reveal rounded-2xl border border-border bg-card p-6"
        style={{ animationDelay: "300ms" }}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <UsersThree weight="duotone" className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">Your referrals</h2>
          </div>
          {referrals.length > 0 && (
            <span className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{activeCount}</span> active
              {" · "}
              <span className="font-semibold text-foreground">{referrals.length}</span> total
            </span>
          )}
        </div>

        {referrals.length === 0 ? (
          <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
              <UsersThree weight="duotone" className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-medium">No referrals yet</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground">
              Share your link above to start earning {RATE_PCT}% of every payment.
            </p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 font-medium">Referral</th>
                  <th className="px-4 py-2.5 font-medium">Joined</th>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {referrals.map((r) => {
                  const s = statusMeta(r.subscriptionStatus);
                  return (
                    <tr
                      key={r.id}
                      className="border-b border-border transition-colors last:border-0 hover:bg-secondary/40"
                    >
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        #{r.id.slice(-8)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {r.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td className="px-4 py-3">{planBadge(r.plan)}</td>
                      <td className="px-4 py-3">
                        <span className={`flex items-center justify-end gap-1.5 ${s.text}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                          {s.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Terms footnote */}
      <p
        className="cc-reveal flex items-center gap-1.5 text-xs text-muted-foreground"
        style={{ animationDelay: "360ms" }}
      >
        <ShieldCheck weight="duotone" className="h-3.5 w-3.5" />
        {RATE_PCT}% of net payments (after processing fees), held {HOLD_DAYS} days, paid on the
        {" "}
        {PAYOUT_DAYS} of each month once your balance reaches {money(MIN_PAYOUT)}.
      </p>
    </div>
  );
}
