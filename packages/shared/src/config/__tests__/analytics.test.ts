import { describe, expect, it } from "vitest";
import { isLocalToday, startOfLocalDay } from "../analytics";

describe("startOfLocalDay", () => {
  it("uses the Riga day in summer, when the zone is UTC+3", () => {
    // 2026-07-28T00:30Z is 03:30 in Riga, so the local day started at 21:00Z
    // on the 27th.
    const at = new Date("2026-07-28T00:30:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-07-27T21:00:00.000Z");
  });

  it("puts late-evening UTC into the NEXT local day", () => {
    // 21:30Z is already 00:30 on the 28th in Riga.
    const at = new Date("2026-07-27T21:30:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-07-27T21:00:00.000Z");
  });

  it("uses the Riga day in winter, when the zone is UTC+2", () => {
    // The case a hardcoded +3 offset gets wrong. 2026-01-15T22:30Z is
    // 00:30 on the 16th in Riga, whose day started at 22:00Z on the 15th.
    const at = new Date("2026-01-15T22:30:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-01-15T22:00:00.000Z");
  });

  it("returns midnight exactly, with no time-of-day left over", () => {
    const start = startOfLocalDay(new Date("2026-07-28T12:34:56.789Z"));
    expect(start.getTime() % 1000).toBe(0);
    expect(start.toISOString()).toBe("2026-07-27T21:00:00.000Z");
  });
});

describe("isLocalToday", () => {
  it("is true for a timestamp inside the current local day", () => {
    const now = new Date("2026-07-28T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-07-27T21:00:00.000Z"), now)).toBe(true);
  });

  it("is false one millisecond before the local day began", () => {
    const now = new Date("2026-07-28T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-07-27T20:59:59.999Z"), now)).toBe(false);
  });

  it("is false for a future day", () => {
    const now = new Date("2026-07-28T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-07-29T00:00:00.000Z"), now)).toBe(false);
  });
});

describe("startOfLocalDay across a DST transition", () => {
  it("finds the true midnight on the spring-forward day", () => {
    // Riga goes +2 to +3 at 03:00 local on 2026-03-29, so that local day began
    // at 22:00Z - an hour later than the +3 offset in force by mid-morning
    // would suggest.
    const at = new Date("2026-03-29T10:00:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-03-28T22:00:00.000Z");
  });

  it("finds the true midnight on the fall-back day", () => {
    // Riga goes +3 to +2 at 04:00 local on 2026-10-25. That local day began at
    // 21:00Z, under the offset that was still in force at midnight.
    const at = new Date("2026-10-25T10:00:00.000Z");
    expect(startOfLocalDay(at).toISOString()).toBe("2026-10-24T21:00:00.000Z");
  });

  it("keeps the last hour of the previous day out of a spring-forward today", () => {
    const now = new Date("2026-03-29T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-03-28T21:30:00.000Z"), now)).toBe(false);
    expect(isLocalToday(new Date("2026-03-28T22:30:00.000Z"), now)).toBe(true);
  });

  it("keeps the first hour of a fall-back day inside today", () => {
    // 21:30Z is 00:30 local on the 25th, still on the old offset.
    const now = new Date("2026-10-25T10:00:00.000Z");
    expect(isLocalToday(new Date("2026-10-24T21:30:00.000Z"), now)).toBe(true);
  });
});
