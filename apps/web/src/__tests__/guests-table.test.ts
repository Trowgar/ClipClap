import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { GuestRow, Page } from "@clipclap/shared";
import { describe, expect, it } from "vitest";
import { GuestsTable } from "../../app/admin/guests-table";

// Next injects the JSX runtime during its build. Vitest compiles this server
// component directly with classic JSX, so provide the same runtime explicitly.
Object.assign(globalThis, { React });

const PAGE: Page = {
  page: 1,
  pageSize: 25,
  skip: 0,
  totalPages: 1,
  from: 1,
  to: 1,
  total: 1,
};

function renderRange(firstSeenAt: string, lastSeenAt: string): string {
  const rows: GuestRow[] = [
    {
      day: new Date("2026-08-28T00:00:00.000Z"),
      visitorHash: "visitor",
      country: null,
      referrerHost: null,
      views: 2,
      durationSec: 3600,
      paths: [
        {
          path: "/",
          hits: 2,
          firstSeenAt: new Date(firstSeenAt),
          lastSeenAt: new Date(lastSeenAt),
        },
      ],
    },
  ];

  return renderToStaticMarkup(createElement(GuestsTable, { rows, page: PAGE }));
}

describe("guest visit timestamps", () => {
  it("keeps a Riga-midnight rollover chronologically legible", () => {
    const html = renderRange(
      "2026-08-28T20:30:00.000Z",
      "2026-08-28T21:30:00.000Z"
    );

    expect(html).toContain("2026-08-28 23:30-2026-08-29 00:30");
  });

  it("shows both calendar date and wall time across Riga spring-forward", () => {
    const html = renderRange(
      "2026-03-29T00:30:00.000Z",
      "2026-03-29T01:30:00.000Z"
    );

    expect(html).toContain("2026-03-29 02:30-2026-03-29 04:30");
  });
});
