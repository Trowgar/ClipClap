import Link from "next/link";
import { PLAN_LIMITS } from "@clipclap/shared";
import { Button } from "@/components/ui/button";
import type { FreeUpgradeOffer } from "@/lib/free-upgrade-offer";
import { ConversionImpression } from "@/components/conversion-impression";

const starter = PLAN_LIMITS.STARTER.WEEKLY!;

export function FreeUpgradeCard({ urgency }: FreeUpgradeOffer) {
  const urgent = urgency === "urgent";

  return (
    <ConversionImpression event="offer_shown" detail={{ placement: "dashboard", plan: "STARTER", cycle: "WEEKLY" }}>
    <section className="relative overflow-hidden rounded-xl border border-orange-400/30 bg-gradient-to-br from-orange-500/10 via-card to-card p-5 shadow-sm">
      <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-orange-400/10 blur-2xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-300">
            {urgent ? "Keep creating" : "Your clips are ready"}
          </p>
          <h2 className="text-lg font-semibold tracking-tight">
            {urgent ? "Almost out of free minutes" : "Keep creating with Starter"}
          </h2>
          <p className="max-w-xl text-sm leading-6 text-muted-foreground">
            {starter.minutesPerPeriod} source minutes every week. Each video must fit your remaining minutes.
            {" "}Longer video? Choose a monthly plan. Clips kept for {starter.retentionDays} days. Renews weekly; cancel anytime.
          </p>
        </div>

        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <p className="text-lg font-semibold tabular-nums">
            ${starter.priceUsd}/week
          </p>
          <Button asChild size="sm">
            <Link href="/dashboard/plans">
              Continue with Starter
            </Link>
          </Button>
        </div>
      </div>
    </section>
    </ConversionImpression>
  );
}
