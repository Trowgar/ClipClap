import { describe, expect, it } from "vitest";
import { getFreeUpgradeOffer } from "../../lib/free-upgrade-offer";

describe("free upgrade offer", () => {
  it("shows a normal offer after a free user receives a clip", () => {
    expect(
      getFreeUpgradeOffer({
        plan: "NONE",
        hasReadyClips: true,
        remainingMinutes: 24,
      })
    ).toEqual({ urgency: "normal" });
  });

  it("uses urgent copy when ten or fewer free minutes remain", () => {
    expect(
      getFreeUpgradeOffer({
        plan: "NONE",
        hasReadyClips: true,
        remainingMinutes: 10,
      })
    ).toEqual({ urgency: "urgent" });
  });

  it("stays hidden without clips or on a paid plan", () => {
    expect(
      getFreeUpgradeOffer({
        plan: "NONE",
        hasReadyClips: false,
        remainingMinutes: 24,
      })
    ).toBeNull();
    expect(
      getFreeUpgradeOffer({
        plan: "STARTER",
        hasReadyClips: true,
        remainingMinutes: 24,
      })
    ).toBeNull();
  });
});
