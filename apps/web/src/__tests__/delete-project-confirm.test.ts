import { describe, expect, it } from "vitest";
import { deleteProjectConfirmMessage } from "../../lib/delete-project-confirm";

/**
 * "This cannot be undone" is about the clips. It says nothing about the free
 * allowance, and a user who deleted a project that was already being
 * transcribed lost the minutes it had reserved with nothing on screen having
 * mentioned minutes at all.
 */
describe("delete confirmation copy", () => {
  it("says nothing about minutes when the press costs none", () => {
    const text = deleteProjectConfirmMessage("My VOD", 3, null);
    expect(text).toContain('Delete "My VOD" and its 3 clips?');
    expect(text).toContain("This cannot be undone.");
    expect(text.toLowerCase()).not.toContain("minute");
  });

  it("names the minutes when the press forfeits them", () => {
    const text = deleteProjectConfirmMessage("My VOD", 0, 1800);
    expect(text).toContain("30 minutes");
    expect(text).toContain("will NOT come back");
  });

  it("rounds a part-minute up rather than reporting zero", () => {
    // Warning about "0 minutes" would be worse than not warning.
    expect(deleteProjectConfirmMessage("x", 0, 30)).toContain("1 minute");
    expect(deleteProjectConfirmMessage("x", 0, 30)).not.toContain("1 minutes");
  });

  it("treats a zero reservation as nothing to lose", () => {
    // An upload reserves 0 SECONDS until the download stage measures it. The
    // seconds are what this warning quotes, so there is nothing to say - and
    // PENDING refunds now anyway, so the server never sends this case.
    expect(deleteProjectConfirmMessage("x", 0, 0).toLowerCase()).not.toContain(
      "minute"
    );
  });

  it("keeps the clip sentence singular for one clip", () => {
    expect(deleteProjectConfirmMessage("x", 1, null)).toContain("its 1 clip?");
  });
});
