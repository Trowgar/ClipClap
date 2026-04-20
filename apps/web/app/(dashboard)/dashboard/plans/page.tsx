import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { userService } from "@clipfast/shared";
import { PlanCard } from "@/components/plan-card";

export default async function PlansPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const usage = await userService.getUsage(session.user.id);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Choose a plan that fits your needs. Cancel anytime.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <PlanCard
          name="Free"
          price="$0"
          period="forever"
          current={usage.plan === "FREE"}
          features={[
            "2 videos per week",
            "10 min max length",
            "Basic subtitles",
            "Watermark on clips",
          ]}
        />
        <PlanCard
          name="Starter"
          price="$3"
          period="week"
          current={usage.plan === "STARTER"}
          planKey="STARTER"
          features={[
            "10 videos per week",
            "60 min max length",
            "3 subtitle styles",
            "No watermark",
            "Telegram bot access",
          ]}
        />
        <PlanCard
          name="Pro"
          price="$5"
          period="week"
          current={usage.plan === "PRO"}
          planKey="PRO"
          features={[
            "30 videos per week",
            "3 hour max length",
            "All subtitle styles",
            "No watermark",
            "Telegram bot access",
            "Priority processing",
          ]}
        />
      </div>
    </div>
  );
}
