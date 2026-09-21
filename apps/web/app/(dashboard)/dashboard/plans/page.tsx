import React from "react";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import {
  userService,
  PLAN_LIMITS,
  TOPUP_PACKS,
  recordFunnelEvent,
  FUNNEL_EVENTS,
} from "@clipclap/shared";
import { PlanCard } from "@/components/plan-card";
import { TopupButton } from "@/components/topup-button";
import { ConversionImpression } from "@/components/conversion-impression";

// Pull canonical pricing/quotas from the shared config so a marketing change
// in plans.ts propagates here without a second edit (and without drift between
// what we render and what Stripe actually charges).
const STARTER_WEEKLY = PLAN_LIMITS.STARTER.WEEKLY!;
const STARTER_MONTHLY = PLAN_LIMITS.STARTER.MONTHLY!;
const PLUS_MONTHLY = PLAN_LIMITS.PLUS.MONTHLY!;
const MAX_MONTHLY = PLAN_LIMITS.MAX.MONTHLY!;

export default async function PlansPage({ searchParams }: {
  searchParams?: Promise<{ durationSec?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);
  await recordFunnelEvent("web", session.user.id, FUNNEL_EVENTS.PLANS_OPENED);
  const duration = Number((await searchParams)?.durationSec);
  const requiredDurationSec = Number.isFinite(duration) && duration > 0 ? duration : undefined;
  const canTopup = Boolean(usage.subscriptionState?.live && usage.currentPeriodEnd && usage.currentPeriodEnd > new Date());

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Choose a plan that fits your workflow. Cancel anytime.
        </p>
      </div>
      <ConversionImpression event="plans_viewed" detail={{ placement: "plans", durationSec: requiredDurationSec }}>
        {requiredDurationSec ? <p className="text-sm text-muted-foreground">Your video: {Math.ceil(requiredDurationSec / 60)} source minutes. Options below must cover the entire source; buying a plan does not submit it automatically.</p> : <p className="text-sm text-muted-foreground">Minutes refer to the original video, not the generated clips.</p>}
      </ConversionImpression>

      <div className="grid gap-6 sm:grid-cols-3">
        <PlanCard
          name="Starter"
          requiredDurationSec={requiredDurationSec}
          maxSourceDurationMinutes={STARTER_MONTHLY.maxSourceDurationMinutes}
          planKey="STARTER"
          cycleOptions={[
            {
              label: "Weekly",
              cycle: "WEEKLY",
              priceUsd: STARTER_WEEKLY.priceUsd,
              minutes: STARTER_WEEKLY.minutesPerPeriod,
            },
            {
              label: "Monthly",
              cycle: "MONTHLY",
              priceUsd: STARTER_MONTHLY.priceUsd,
              minutes: STARTER_MONTHLY.minutesPerPeriod,
            },
          ]}
          features={[
            `${STARTER_MONTHLY.storageClips} clips stored`,
            `${STARTER_MONTHLY.retentionDays}-day retention`,
            "TikTok subtitle style",
          ]}
          current={usage.plan === "STARTER"}
          currentCycle={usage.billingCycle}
        />
        <PlanCard
          name="Plus"
          requiredDurationSec={requiredDurationSec}
          maxSourceDurationMinutes={PLUS_MONTHLY.maxSourceDurationMinutes}
          planKey="PLUS"
          cycleOptions={[
            {
              label: "Monthly",
              cycle: "MONTHLY",
              priceUsd: PLUS_MONTHLY.priceUsd,
              minutes: PLUS_MONTHLY.minutesPerPeriod,
            },
          ]}
          features={[
            `${PLUS_MONTHLY.storageClips} clips stored`,
            `${PLUS_MONTHLY.retentionDays}-day retention`,
            "Burned-in subtitles",
            `${PLUS_MONTHLY.concurrentJobsLimit} jobs at once`,
          ]}
          current={usage.plan === "PLUS"}
          currentCycle={usage.billingCycle}
          highlighted
        />
        <PlanCard
          name="Max"
          requiredDurationSec={requiredDurationSec}
          maxSourceDurationMinutes={MAX_MONTHLY.maxSourceDurationMinutes}
          planKey="MAX"
          cycleOptions={[
            {
              label: "Monthly",
              cycle: "MONTHLY",
              priceUsd: MAX_MONTHLY.priceUsd,
              minutes: MAX_MONTHLY.minutesPerPeriod,
            },
          ]}
          features={[
            `${MAX_MONTHLY.storageClips} clips stored`,
            `${MAX_MONTHLY.retentionDays}-day retention`,
            `${MAX_MONTHLY.concurrentJobsLimit} jobs at once`,
            "Priority processing",
          ]}
          current={usage.plan === "MAX"}
          currentCycle={usage.billingCycle}
        />
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold">Need more minutes?</h2>
          <p className="text-sm text-muted-foreground">
            Top up without changing your plan. Credits expire at the end of your current period.
          </p>
        </div>
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          <TopupButton
            pack="SMALL"
            requiredDurationSec={requiredDurationSec}
            remainingMinutes={usage.minutesLimit + usage.topUpMinutesRemaining - usage.minutesUsed}
            maxSourceDurationMinutes={STARTER_MONTHLY.maxSourceDurationMinutes}
            enabled={canTopup}
            minutes={TOPUP_PACKS.SMALL.minutes}
            priceUsd={TOPUP_PACKS.SMALL.priceUsd}
          />
          <TopupButton
            pack="LARGE"
            requiredDurationSec={requiredDurationSec}
            remainingMinutes={usage.minutesLimit + usage.topUpMinutesRemaining - usage.minutesUsed}
            maxSourceDurationMinutes={STARTER_MONTHLY.maxSourceDurationMinutes}
            enabled={canTopup}
            minutes={TOPUP_PACKS.LARGE.minutes}
            priceUsd={TOPUP_PACKS.LARGE.priceUsd}
          />
        </div>
      </section>
    </div>
  );
}
