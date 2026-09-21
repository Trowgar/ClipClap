import { expect, it } from "vitest";
import { getSourcePurchaseOption } from "../plans";

it("offers an existing plan that covers the whole source, not just its upload cap", () => {
  expect(getSourcePurchaseOption(60 * 60)).toMatchObject({ plan: "STARTER", cycle: "WEEKLY", minutesPerPeriod: 75 });
  for (const minutes of [92, 177, 180]) {
    expect(getSourcePurchaseOption(minutes * 60)).toMatchObject({ plan: "STARTER", cycle: "MONTHLY", minutesPerPeriod: 270 });
  }
  for (const seconds of [180 * 60 + 1, 0, -1, NaN, Infinity]) {
    expect(getSourcePurchaseOption(seconds)).toBeNull();
  }
});
