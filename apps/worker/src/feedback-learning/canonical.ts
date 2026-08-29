import { createHash } from "node:crypto";

import type { Sha256 } from "./types";

type CapturedJson =
  | null
  | boolean
  | number
  | string
  | CapturedJson[]
  | { [key: string]: CapturedJson };

function invalidValue(): never {
  throw new TypeError("canonical_json_invalid_value");
}

function invalidCycle(): never {
  throw new TypeError("canonical_json_cycle");
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && Object.prototype.hasOwnProperty.call(descriptor, "value");
}

function captureArray(value: unknown[], ancestors: Set<object>): CapturedJson[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) return invalidValue();

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    !isDataDescriptor(lengthDescriptor) ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    (lengthDescriptor.value as number) < 0
  ) {
    return invalidValue();
  }
  const length = lengthDescriptor.value as number;
  const keys = Reflect.ownKeys(value);
  const captured = new Array<CapturedJson>(length);
  const seenIndexes = new Set<number>();
  for (const key of keys) {
    if (typeof key === "symbol") return invalidValue();
    if (key === "length") continue;

    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (!/^(0|[1-9]\d*)$/.test(key)) return invalidValue();
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index >= length || !isDataDescriptor(descriptor)) {
      return invalidValue();
    }
    captured[index] = captureJsonValueInternal(descriptor.value, ancestors);
    seenIndexes.add(index);
  }
  if (seenIndexes.size !== length) return invalidValue();
  return captured;
}

function captureObject(
  value: object,
  ancestors: Set<object>
): { [key: string]: CapturedJson } {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidValue();

  const captured: { [key: string]: CapturedJson } = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") return invalidValue();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) continue;
    if (!isDataDescriptor(descriptor)) return invalidValue();
    Object.defineProperty(captured, key, {
      configurable: true,
      enumerable: true,
      value: captureJsonValueInternal(descriptor.value, ancestors),
      writable: true,
    });
  }
  return captured;
}

function captureJsonValueInternal(value: unknown, ancestors: Set<object>): CapturedJson {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) return invalidValue();
      return value;
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

  if (ancestors.has(value)) return invalidCycle();
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? captureArray(value, ancestors)
      : captureObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function captureJsonValue(value: unknown): CapturedJson {
  try {
    return captureJsonValueInternal(value, new Set<object>());
  } catch (error) {
    if (
      error instanceof TypeError &&
      (error.message === "canonical_json_invalid_value" ||
        error.message === "canonical_json_cycle")
    ) {
      throw error;
    }
    return invalidValue();
  }
}

function canonicalCaptured(value: CapturedJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCaptured).join(",")}]`;
  }

  const keys = Object.keys(value).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalCaptured(value[key])}`)
    .join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalCaptured(captureJsonValue(value));
}

export function sha256(value: string | Buffer): Sha256 {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function jsonLine(value: unknown): Buffer {
  const captured = captureJsonValue(value);
  return Buffer.from(`${JSON.stringify(captured)}\n`, "utf8");
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
