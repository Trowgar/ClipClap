import { createHash } from "node:crypto";

import type { Sha256 } from "./types";

function invalidValue(): never {
  throw new TypeError("canonical_json_invalid_value");
}

function canonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) return invalidValue();
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      return invalidValue();
    case "object":
      break;
    default:
      return invalidValue();
  }

  if (ancestors.has(value)) throw new TypeError("canonical_json_cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const elements: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return invalidValue();
        elements.push(canonical(value[index], ancestors));
      }
      if (Object.getOwnPropertySymbols(value).length > 0) return invalidValue();
      return `[${elements.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidValue();
    if (Object.getOwnPropertySymbols(value).length > 0) return invalidValue();

    const keys = Object.keys(value).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    const properties = keys.map(
      (key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], ancestors)}`
    );
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return canonical(value, new Set<object>());
}

export function sha256(value: string | Buffer): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function jsonLine(value: unknown): Buffer {
  canonicalJson(value);
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

export function parseUtcMillisecond(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError("utc_millisecond_invalid");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError("utc_millisecond_invalid");
  }
  return parsed;
}
