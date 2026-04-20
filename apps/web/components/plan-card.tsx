"use client";

import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

interface PlanCardProps {
  name: string;
  price: string;
  period: string;
  features: string[];
  current: boolean;
  planKey?: "STARTER" | "PRO";
}

export function PlanCard({
  name,
  price,
  period,
  features,
  current,
  planKey,
}: PlanCardProps) {
  const [loading, setLoading] = useState(false);

  const handleUpgrade = async () => {
    if (!planKey) return;
    setLoading(true);
    try {
      const { url } = await api.billing.checkout(planKey);
      window.location.href = url;
    } catch (err) {
      console.error("Checkout failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card
      className={cn(
        "flex flex-col p-6 border-border",
        current && "border-primary"
      )}
    >
      <div className="mb-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold">{name}</h3>
          {current && <Badge>Current</Badge>}
        </div>
        <div className="mt-2">
          <span className="text-3xl font-bold">{price}</span>
          <span className="text-sm text-muted-foreground">/{period}</span>
        </div>
      </div>

      <ul className="mb-6 flex-1 space-y-2">
        {features.map((feature) => (
          <li key={feature} className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-green-500 shrink-0" />
            {feature}
          </li>
        ))}
      </ul>

      {current ? (
        <Button variant="outline" disabled>
          Current Plan
        </Button>
      ) : planKey ? (
        <Button onClick={handleUpgrade} disabled={loading}>
          {loading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Upgrade to {name}
        </Button>
      ) : (
        <Button variant="outline" disabled>
          Free
        </Button>
      )}
    </Card>
  );
}
