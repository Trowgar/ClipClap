import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getUsageForUser } from "@clipfast/shared";
import { PlanCard } from "@/components/plan-card";
import { TopupButton } from "@/components/topup-button";

export default async function PlansPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await getUsageForUser(session.user.id);

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
            { label: "Weekly", cycle: "WEEKLY", priceUsd: 3, minutes: 75 },
            { label: "Monthly", cycle: "MONTHLY", priceUsd: 9, minutes: 270 },
          ]}
          features={[
            "Up to 180 min per upload",
            "20 clips stored",
            "7-day retention",
            "TikTok subtitle style",
          ]}
          current={usage.plan === "STARTER"}
          currentCycle={usage.billingCycle}
        />
        <PlanCard
          name="Plus"
          planKey="PLUS"
          cycleOptions={[
            { label: "Monthly", cycle: "MONTHLY", priceUsd: 29, minutes: 1000 },
          ]}
          features={[
            "Up to 180 min per upload",
            "150 clips stored",
            "30-day retention",
            "3 subtitle styles",
            "2 jobs at once",
          ]}
          current={usage.plan === "PLUS"}
          currentCycle={usage.billingCycle}
          highlighted
        />
        <PlanCard
          name="Max"
          planKey="MAX"
          cycleOptions={[
            { label: "Monthly", cycle: "MONTHLY", priceUsd: 89, minutes: 3500 },
          ]}
          features={[
            "Up to 180 min per upload",
            "1000 clips stored",
            "90-day retention",
            "All subtitle styles",
            "3 jobs at once",
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
          <TopupButton pack="SMALL" minutes={100} priceUsd={6} />
          <TopupButton pack="LARGE" minutes={300} priceUsd={15} />
        </div>
      </section>
    </div>
  );
}
