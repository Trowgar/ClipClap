export type FreeUpgradeOffer = {
  urgency: "normal" | "urgent";
};

export function getFreeUpgradeOffer(input: {
  plan: string;
  hasReadyClips: boolean;
  remainingMinutes: number;
}): FreeUpgradeOffer | null {
  if (input.plan !== "NONE" || !input.hasReadyClips) return null;

  return {
    urgency: input.remainingMinutes <= 10 ? "urgent" : "normal",
  };
}
