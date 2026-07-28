import { describe, expect, it } from "vitest";
import { paginate } from "../analytics-detail.service";

describe("paginate", () => {
  it("describes the first page", () => {
    expect(paginate(68, 1, 25)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      totalPages: 3,
      from: 1,
      to: 25,
      total: 68,
    });
  });

  it("describes a middle page", () => {
    expect(paginate(68, 2, 25)).toMatchObject({ skip: 25, from: 26, to: 50 });
  });

  it("stops `to` at the total on the last page", () => {
    expect(paginate(68, 3, 25)).toMatchObject({ skip: 50, from: 51, to: 68 });
  });

  it("clamps a page past the end to the last page", () => {
    // A stale bookmark must show the last page, not an empty table.
    expect(paginate(68, 99, 25)).toMatchObject({ page: 3, skip: 50 });
  });

  it("clamps a page below one", () => {
    expect(paginate(68, 0, 25)).toMatchObject({ page: 1, skip: 0 });
    expect(paginate(68, -5, 25)).toMatchObject({ page: 1, skip: 0 });
  });

  it("survives an empty table", () => {
    expect(paginate(0, 1, 25)).toEqual({
      page: 1,
      pageSize: 25,
      skip: 0,
      totalPages: 1,
      from: 0,
      to: 0,
      total: 0,
    });
  });
});
