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

  it.each(["object", "array"] as const)(
    "rejects an enumerable %s accessor without invoking it",
    (kind) => {
      let reads = 0;
      const value: Record<string, unknown> | unknown[] = kind === "object" ? {} : [0];
      Object.defineProperty(value, kind === "object" ? "value" : "0", {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1;
          return reads;
        },
      });

      expect(() => canonicalJson(value)).toThrowError("canonical_json_invalid_value");
      expect(reads).toBe(0);
    }
  );

  it.each([
    ["object", Object.assign(Object.create({ inherited: "poison" }), { own: "safe" })],
    ["array", Object.setPrototypeOf(["safe"], { inherited: "poison" })],
  ])("rejects a %s with a non-plain prototype", (_kind, value) => {
    expect(() => canonicalJson(value)).toThrowError("canonical_json_invalid_value");
  });

  it("ignores an inherited numeric Array accessor without invoking it", () => {
    const input = [1];
    const prior = Object.getOwnPropertyDescriptor(Array.prototype, "0");
    let reads = 0;
    let canonical: string | undefined;
    let line: Buffer | undefined;
    let canonicalError: unknown;
    let lineError: unknown;
    try {
      Object.defineProperty(Array.prototype, "0", {
        configurable: true,
        get: () => {
          reads += 1;
          return "poison";
        },
      });
      try {
        canonical = canonicalJson(input);
      } catch (error) {
        canonicalError = error;
      }
      try {
        line = jsonLine(input);
      } catch (error) {
        lineError = error;
      }
    } finally {
      if (prior === undefined) Reflect.deleteProperty(Array.prototype, "0");
      else Object.defineProperty(Array.prototype, "0", prior);
    }

    expect(canonicalError).toBeUndefined();
    expect(lineError).toBeUndefined();
    expect(canonical).toBe("[1]");
    expect(line).toEqual(Buffer.from("[1]\n", "utf8"));
    expect(reads).toBe(0);
  });

  it("isolates captured arrays from an inherited toJSON hook", () => {
    const input = [1];
    const prior = Object.getOwnPropertyDescriptor(Array.prototype, "toJSON");
    let calls = 0;
    let canonical: string | undefined;
    let line: Buffer | undefined;
    try {
      Object.defineProperty(Array.prototype, "toJSON", {
        configurable: true,
        value: () => {
          calls += 1;
          return "poison";
        },
        writable: true,
      });
      canonical = canonicalJson(input);
      line = jsonLine(input);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(Array.prototype, "toJSON");
      else Object.defineProperty(Array.prototype, "toJSON", prior);
    }

    expect(canonical).toBe("[1]");
    expect(line).toEqual(Buffer.from("[1]\n", "utf8"));
    expect(calls).toBe(0);
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

  it("rejects a changing getter without reading it or emitting divergent bytes", () => {
    let reads = 0;
    const value = { stable: true } as Record<string, unknown>;
    Object.defineProperty(value, "changing", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads;
      },
    });

    expect(() => jsonLine(value)).toThrowError("canonical_json_invalid_value");
    expect(reads).toBe(0);
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
