import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  jsonLine,
  parseUtcMillisecond,
  sha256,
} from "../feedback-learning/canonical";

describe("canonicalJson", () => {
  it("sorts object keys recursively with the byte-stable comparator and preserves arrays", () => {
    const value = {
      z: [{ é: 1, aa: 2, a: 3 }, false],
      a: { z: null, b: "text", a: 4 },
    };

    expect(canonicalJson(value)).toBe(
      '{"a":{"a":4,"b":"text","z":null},"z":[{"a":3,"aa":2,"é":1},false]}'
    );
  });

  it("serializes JSON primitives normally and represents a missing snapshot as null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson([true, false, 0, -1.5, "\u0000\n雪"])).toBe(
      '[true,false,0,-1.5,"\\u0000\\n雪"]'
    );
  });

  it.each([
    ["undefined", undefined],
    ["function", () => undefined],
    ["symbol", Symbol("x")],
    ["bigint", 1n],
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["negative infinity", Number.NEGATIVE_INFINITY],
    ["array hole", new Array(1)],
    ["nested undefined", { value: undefined }],
  ])("rejects the non-JSON value %s deterministically", (_label, value) => {
    expect(() => canonicalJson(value)).toThrowError("canonical_json_invalid_value");
  });

  it("rejects cycles deterministically", () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => canonicalJson(value)).toThrowError("canonical_json_cycle");
  });

  it("rejects non-plain JSON objects instead of depending on custom serialization", () => {
    expect(() => canonicalJson(new Date("2026-08-29T00:00:00.000Z"))).toThrowError(
      "canonical_json_invalid_value"
    );
  });
});

describe("sha256", () => {
  it("returns the lowercase prefixed SHA-256 of UTF-8 strings and buffers", () => {
    const expected =
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    expect(sha256("abc")).toBe(expected);
    expect(sha256(Buffer.from("abc", "utf8"))).toBe(expected);
    expect(sha256("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("jsonLine", () => {
  it("returns compact UTF-8 bytes in contract field order with exactly one terminal LF", () => {
    const bytes = jsonLine({ z: "雪", a: [2, 1] });

    expect(bytes).toEqual(Buffer.from('{"z":"雪","a":[2,1]}\n', "utf8"));
    expect([...bytes.subarray(-1)]).toEqual([0x0a]);
  });
});

describe("parseUtcMillisecond", () => {
  it("accepts only a canonical UTC ISO timestamp with millisecond precision", () => {
    const parsed = parseUtcMillisecond("2024-02-29T23:59:59.007Z");

    expect(parsed.toISOString()).toBe("2024-02-29T23:59:59.007Z");
  });

  it.each([
    "2024-02-29T23:59:59Z",
    "2024-02-29T23:59:59.07Z",
    "2024-02-29T23:59:59.000+00:00",
    "2024-02-29t23:59:59.000z",
    "2023-02-29T00:00:00.000Z",
    "2024-13-01T00:00:00.000Z",
    "2024-01-01T24:00:00.000Z",
    "+010000-01-01T00:00:00.000Z",
  ])("rejects the non-canonical or nonexistent timestamp %s", (value) => {
    expect(() => parseUtcMillisecond(value)).toThrowError("utc_millisecond_invalid");
  });
});
