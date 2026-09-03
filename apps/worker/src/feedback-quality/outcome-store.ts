import { join, resolve } from "node:path";

import type { CommitResult, QualityStoreFault, QualityStoreFaultInjector } from "./store";
import {
  appendPrivateLedgerEvent,
  ensurePrivateDirectories,
  ensurePrivateLedger,
  PrivateLedgerDuplicateError,
  QualityStoreError,
  readPrivateLedgerEvents,
  type PrivateLedgerPaths,
  withPrivateLedgerTransaction,
} from "./store";
import { parseOutcomeLabel, type OutcomeLabel } from "./outcome-types";
import type { LockOptions } from "../feedback-learning/lock";

const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const LAYOUT = Object.freeze({ eventsFileName: "outcomes.jsonl", lockFileName: "outcomes.lock" });

export const DEFAULT_OUTCOME_ROOT = resolve(__dirname, "../../.corpus/feedback-quality-gate/outcomes");

export type OutcomeStorePaths = PrivateLedgerPaths & Readonly<{
  casesDir: string;
  observationsDir: string;
  decisionsDir: string;
}>;

export interface OutcomeRetirement {
  readonly schemaVersion: 1;
  readonly action: "retire";
  readonly eventId: string;
  readonly occurredAt: string;
  readonly targetEventId: string;
}

export type OutcomeEvent = OutcomeLabel | OutcomeRetirement;

export type AppendOutcomeOptions = Readonly<{
  injectFault?: QualityStoreFaultInjector;
  tempSuffix?: string;
  lockOptions?: LockOptions;
  /** Test-only adversarial hook, invoked while outcomes.lock is held. */
  afterLock?: () => void | Promise<void>;
  /** Promotion-time authority check. Runs under outcomes.lock against the
   * active, already-validated labels immediately before the append. */
  validateBeforeCommit?: (active: readonly OutcomeLabel[]) => void | Promise<void>;
}>;

export { type QualityStoreFault as OutcomeStoreFault };

export class OutcomeStoreError extends Error {
  readonly code: "invalid_event" | "duplicate_event" | "invalid_retirement" | "unsafe_path" | "integrity";

  constructor(code: OutcomeStoreError["code"]) {
    super(code);
    this.name = "OutcomeStoreError";
    this.code = code;
  }
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function parseRetirement(value: unknown): OutcomeRetirement {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new OutcomeStoreError("invalid_event");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ["action", "eventId", "occurredAt", "schemaVersion", "targetEventId"];
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") || Object.keys(descriptors).sort().join(",") !== expected.join(",")) {
    throw new OutcomeStoreError("invalid_event");
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, "value")) throw new OutcomeStoreError("invalid_event");
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== 1 || raw.action !== "retire" || typeof raw.eventId !== "string" || !EVENT_ID.test(raw.eventId) ||
      typeof raw.targetEventId !== "string" || !EVENT_ID.test(raw.targetEventId) || !canonicalUtc(raw.occurredAt) || raw.eventId === raw.targetEventId) {
    throw new OutcomeStoreError("invalid_event");
  }
  return Object.freeze({
    schemaVersion: 1,
    action: "retire",
    eventId: raw.eventId,
    occurredAt: raw.occurredAt,
    targetEventId: raw.targetEventId,
  });
}

function parseEvent(value: unknown): OutcomeEvent {
  try {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const action = Object.getOwnPropertyDescriptor(value, "action");
      if (action && Object.prototype.hasOwnProperty.call(action, "value") && action.value === "retire") return parseRetirement(value);
    }
    return parseOutcomeLabel(value);
  } catch (error) {
    if (error instanceof OutcomeStoreError) throw error;
    throw new OutcomeStoreError("invalid_event");
  }
}

function activeLabels(events: readonly Readonly<Record<string, unknown>>[]): OutcomeLabel[] {
  const labels = new Map<string, OutcomeLabel>();
  const retired = new Set<string>();
  const seenEventIds = new Set<string>();
  for (const raw of events) {
    const event = parseEvent(raw);
    if (seenEventIds.has(event.eventId)) throw new OutcomeStoreError("integrity");
    seenEventIds.add(event.eventId);
    if (event.action === "label") {
      if ([...labels.entries()].some(([eventId, label]) => !retired.has(eventId) && label.caseVersion === event.caseVersion)) {
        throw new OutcomeStoreError("integrity");
      }
      labels.set(event.eventId, event);
    }
    else {
      if (!labels.has(event.targetEventId) || retired.has(event.targetEventId)) throw new OutcomeStoreError("integrity");
      retired.add(event.targetEventId);
    }
  }
  return [...labels.entries()].filter(([eventId]) => !retired.has(eventId)).map(([, event]) => event);
}

function translateStoreError(error: unknown): never {
  if (error instanceof OutcomeStoreError) throw error;
  if (error instanceof PrivateLedgerDuplicateError) throw new OutcomeStoreError("duplicate_event");
  if (error instanceof QualityStoreError) {
    if (error.code === "unsafe_path") throw new OutcomeStoreError("unsafe_path");
    if (error.code === "invalid_input") throw new OutcomeStoreError("invalid_event");
    throw new OutcomeStoreError("integrity");
  }
  throw error;
}

export async function ensureOutcomeStore(root = DEFAULT_OUTCOME_ROOT): Promise<OutcomeStorePaths> {
  try {
    const paths = await ensurePrivateLedger(root, LAYOUT);
    await ensurePrivateDirectories(paths.root, ["cases", "observations", "decisions"]);
    return Object.freeze({
      ...paths,
      casesDir: join(paths.root, "cases"),
      observationsDir: join(paths.root, "observations"),
      decisionsDir: join(paths.root, "decisions"),
    });
  }
  catch (error) { return translateStoreError(error); }
}

export async function appendOutcomeEvent(
  root: string,
  rawEvent: OutcomeEvent,
  options: AppendOutcomeOptions = {},
): Promise<CommitResult> {
  const event = parseEvent(rawEvent);
  try {
    await ensureOutcomeStore(root);
    return await appendPrivateLedgerEvent(event as unknown as Readonly<{ eventId: string; [key: string]: unknown }>, root, LAYOUT, {
      ...options,
      rejectDuplicate: true,
      validateBeforeCommit(events) {
        const active = activeLabels(events);
        if (event.action === "label") {
          if (active.some((label) => label.caseVersion === event.caseVersion)) throw new OutcomeStoreError("invalid_retirement");
          return options.validateBeforeCommit?.(Object.freeze([...active]));
        }
        if (!active.some((label) => label.eventId === event.targetEventId)) throw new OutcomeStoreError("invalid_retirement");
        return options.validateBeforeCommit?.(Object.freeze([...active]));
      },
    });
  } catch (error) { return translateStoreError(error); }
}

export async function readActiveOutcomeLabels(root = DEFAULT_OUTCOME_ROOT): Promise<readonly OutcomeLabel[]> {
  try {
    await ensureOutcomeStore(root);
    const events = await readPrivateLedgerEvents(root, LAYOUT);
    return Object.freeze(activeLabels(events));
  } catch (error) { return translateStoreError(error); }
}

export type OutcomePublicationAuthority = Readonly<{
  rootPath: string;
  active: readonly OutcomeLabel[];
  assertCurrent: () => Promise<void>;
  appendLabel: (label: OutcomeLabel, injectFault?: QualityStoreFaultInjector) => Promise<CommitResult>;
}>;

export async function withOutcomePublication<T>(
  root: string,
  operation: (authority: OutcomePublicationAuthority) => Promise<T>,
): Promise<T> {
  try {
    await ensureOutcomeStore(root);
    return await withPrivateLedgerTransaction(root, LAYOUT, async (transaction) => {
      const active = Object.freeze(activeLabels(transaction.events));
      return operation(Object.freeze({
        rootPath: transaction.rootPath,
        active,
        assertCurrent: transaction.assertCurrent,
        appendLabel: (label, injectFault) => transaction.append(parseOutcomeLabel(label) as unknown as Readonly<{ eventId: string; [key: string]: unknown }>, {
          rejectDuplicate: true,
          injectFault,
          validateBeforeCommit(events) {
            const current = activeLabels(events);
            if (current.some((entry) => entry.caseVersion === label.caseVersion)) throw new OutcomeStoreError("invalid_retirement");
          },
        }),
      }));
    });
  } catch (error) { return translateStoreError(error); }
}
