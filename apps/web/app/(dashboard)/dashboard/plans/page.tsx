import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { userService, PLAN_LIMITS, TOPUP_PACKS } from "@clipfast/shared";
import { PlanCard } from "@/components/plan-card";
import { TopupButton } from "@/components/topup-button";

// Pull canonical pricing/quotas from the shared config so a marketing change
// in plans.ts propagates here without a second edit (and without drift between
// what we render and what Stripe actually charges).
const STARTER_WEEKLY = PLAN_LIMITS.STARTER.WEEKLY!;
const STARTER_MONTHLY = PLAN_LIMITS.STARTER.MONTHLY!;
const PLUS_MONTHLY = PLAN_LIMITS.PLUS.MONTHLY!;
const MAX_MONTHLY = PLAN_LIMITS.MAX.MONTHLY!;

export default async function PlansPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);

  return (
    <div className="mx-auto max-w-5xl space-y-10">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Choose a plan that fits your workflow. Cancel anytime.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <PlanCard
          name="Starter"
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
            `Up to ${STARTER_MONTHLY.maxSourceDurationMinutes} min per upload`,
            `${STARTER_MONTHLY.storageClips} clips stored`,
            `${STARTER_MONTHLY.retentionDays}-day retention`,
            "TikTok subtitle style",
          ]}
          current={usage.plan === "STARTER"}
          currentCycle={usage.billingCycle}
        />
        <PlanCard
          name="Plus"
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
            `Up to ${PLUS_MONTHLY.maxSourceDurationMinutes} min per upload`,
            `${PLUS_MONTHLY.storageClips} clips stored`,
            `${PLUS_MONTHLY.retentionDays}-day retention`,
            `${PLUS_MONTHLY.subtitlePresets.length} subtitle styles`,
            `${PLUS_MONTHLY.concurrentJobsLimit} jobs at once`,
          ]}
          current={usage.plan === "PLUS"}
          currentCycle={usage.billingCycle}
          highlighted
        />
        <PlanCard
          name="Max"
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
            `Up to ${MAX_MONTHLY.maxSourceDurationMinutes} min per upload`,
            `${MAX_MONTHLY.storageClips} clips stored`,
            `${MAX_MONTHLY.retentionDays}-day retention`,
            "All subtitle styles",
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
            minutes={TOPUP_PACKS.SMALL.minutes}
            priceUsd={TOPUP_PACKS.SMALL.priceUsd}
          />
          <TopupButton
            pack="LARGE"
            minutes={TOPUP_PACKS.LARGE.minutes}
            priceUsd={TOPUP_PACKS.LARGE.priceUsd}
          />
        </div>
      </section>
    </div>
  );
}
