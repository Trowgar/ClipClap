import {
  isCandidateType,
  isNormalizedCandidateInterest,
} from "./types";
import type {
  CandidatePrimaryDisposition,
  CandidateRecoveryDisposition,
  CandidateType,
  MergedCandidate,
} from "./types";

const PRIMARY_DISPOSITIONS: readonly CandidatePrimaryDisposition[] = Object.freeze([
  "not_selected_for_critic",
  "critic_unjudged",
  "critic_rejected",
  "evidence_rejected",
  "snap_rejected",
  "selection_not_chosen",
  "arc_rejected",
  "post_boundary_rejected",
  "standalone_rejected",
  "finalizer_rejected",
  "shipped",
]);

const RECOVERY_DISPOSITIONS: readonly CandidateRecoveryDisposition[] = Object.freeze(
  PRIMARY_DISPOSITIONS.filter(
    (disposition): disposition is CandidateRecoveryDisposition =>
      disposition !== "not_selected_for_critic",
  ),
);

export type CandidateTraceDescriptor = Readonly<
  Omit<Pick<MergedCandidate, "id" | "startNode" | "endNode" | "payoffNode" | "interest" | "type">, "type"> & {
    type: CandidateType;
  }
>;

export interface CandidateTraceEntry extends CandidateTraceDescriptor {
  primary?: CandidatePrimaryDisposition;
  recovery?: CandidateRecoveryDisposition;
}

type CountMap<T extends string> = Partial<Record<T, number>>;

export interface CandidateTraceSerialized {
  primary: CountMap<CandidatePrimaryDisposition>;
  recovery: CountMap<CandidateRecoveryDisposition>;
}

export interface CandidateTrace {
  terminatePrimary(id: string, disposition: CandidatePrimaryDisposition): void;
  registerRecoveryCandidates(ids: readonly string[]): void;
  terminateRecovery(id: string, disposition: CandidateRecoveryDisposition): void;
  summaryPrimary(): CountMap<CandidatePrimaryDisposition>;
  summaryRecovery(): CountMap<CandidateRecoveryDisposition>;
  inspect(): readonly CandidateTraceEntry[];
  serialize(): CandidateTraceSerialized;
  toJSON(): CandidateTraceSerialized;
}

function fail(code: string): never {
  throw new Error(code);
}

function isDisposition<T extends string>(
  value: string,
  values: readonly T[],
): value is T {
  return values.includes(value as T);
}

function increment<T extends string>(
  counts: Map<T, number>,
  disposition: T,
): void {
  counts.set(disposition, (counts.get(disposition) ?? 0) + 1);
}

function countsObject<T extends string>(
  counts: Map<T, number>,
  order: readonly T[],
): CountMap<T> {
  const result: CountMap<T> = {};
  for (const disposition of order) {
    const count = counts.get(disposition);
    if (count !== undefined) result[disposition] = count;
  }
  return result;
}

function isSafeDescriptor(value: unknown): value is CandidateTraceDescriptor {
  if (value === null || typeof value !== "object") return false;
  const descriptor = value as Record<string, unknown>;
  const startNode = descriptor.startNode;
  const payoffNode = descriptor.payoffNode;
  const endNode = descriptor.endNode;
  return (
    typeof descriptor.id === "string" &&
    descriptor.id.length > 0 &&
    Number.isInteger(startNode) &&
    Number.isInteger(payoffNode) &&
    Number.isInteger(endNode) &&
    (startNode as number) >= 0 &&
    (startNode as number) <= (payoffNode as number) &&
    (payoffNode as number) <= (endNode as number) &&
    isNormalizedCandidateInterest(descriptor.interest) &&
    isCandidateType(descriptor.type)
  );
}

/**
 * Create an in-memory, append-only accounting trace for one candidate set.
 * Candidate descriptors contain only safe geometry/score/type metadata. They
 * are copied and frozen at admission, while aggregate serialization remains
 * counts-only so transcript, user, media, and model prose cannot leak.
 */
export function createCandidateTrace(
  candidateDescriptors: readonly CandidateTraceDescriptor[],
): CandidateTrace {
  if (!Array.isArray(candidateDescriptors)) fail("invalid_candidate_descriptors");
  const ids = new Set<string>();
  const descriptors = new Map<string, CandidateTraceDescriptor>();
  for (const candidate of candidateDescriptors) {
    if (!isSafeDescriptor(candidate)) fail("invalid_candidate_descriptor");
    const id = candidate.id;
    if (ids.has(id)) fail("duplicate_candidate");
    ids.add(id);
    descriptors.set(id, Object.freeze({
      id: candidate.id,
      startNode: candidate.startNode,
      payoffNode: candidate.payoffNode,
      endNode: candidate.endNode,
      interest: candidate.interest,
      type: candidate.type,
    }));
  }

  const primary = new Map<string, CandidatePrimaryDisposition>();
  const recovery = new Map<string, CandidateRecoveryDisposition>();
  const registeredRecovery = new Set<string>();
  const primaryCounts = new Map<CandidatePrimaryDisposition, number>();
  const recoveryCounts = new Map<CandidateRecoveryDisposition, number>();

  const requireKnown = (id: string): void => {
    if (!ids.has(id)) fail("unknown_candidate");
  };

  const requireCompletePrimary = (): void => {
    for (const id of ids) {
      if (!primary.has(id)) fail("incomplete_primary_disposition");
    }
  };

  const requireCompleteRecovery = (): void => {
    for (const id of registeredRecovery) {
      if (!recovery.has(id)) fail("incomplete_recovery_disposition");
    }
  };

  return {
    terminatePrimary(id, disposition) {
      requireKnown(id);
      if (primary.has(id)) fail("duplicate_disposition");
      if (!isDisposition(disposition, PRIMARY_DISPOSITIONS)) {
        fail("invalid_primary_disposition");
      }
      primary.set(id, disposition);
      increment(primaryCounts, disposition);
    },

    registerRecoveryCandidates(candidateIds) {
      const requested = new Set<string>();
      // Preflight the complete registration so a bad batch cannot partially
      // enroll its earlier entries.
      for (const id of candidateIds) {
        requireKnown(id);
        if (requested.has(id) || registeredRecovery.has(id)) {
          fail("duplicate_recovery_registration");
        }
        if (primary.get(id) !== "not_selected_for_critic") {
          fail("primary_disposition_required");
        }
        requested.add(id);
      }
      for (const id of requested) registeredRecovery.add(id);
    },

    terminateRecovery(id, disposition) {
      requireKnown(id);
      if (!registeredRecovery.has(id)) fail("unregistered_recovery_candidate");
      if (recovery.has(id)) fail("duplicate_disposition");
      if (!isDisposition(disposition, RECOVERY_DISPOSITIONS)) {
        fail("invalid_recovery_disposition");
      }
      if (primary.get(id) !== "not_selected_for_critic") {
        fail("primary_disposition_required");
      }
      recovery.set(id, disposition);
      increment(recoveryCounts, disposition);
    },

    summaryPrimary() {
      requireCompletePrimary();
      return countsObject(primaryCounts, PRIMARY_DISPOSITIONS);
    },

    summaryRecovery() {
      requireCompleteRecovery();
      return countsObject(recoveryCounts, RECOVERY_DISPOSITIONS);
    },

    inspect() {
      const entries: CandidateTraceEntry[] = [];
      for (const [id, descriptor] of descriptors) {
        entries.push(Object.freeze({
          ...descriptor,
          ...(primary.has(id) ? { primary: primary.get(id) } : {}),
          ...(recovery.has(id) ? { recovery: recovery.get(id) } : {}),
        }));
      }
      return Object.freeze(entries);
    },

    serialize() {
      requireCompletePrimary();
      requireCompleteRecovery();
      return {
        primary: countsObject(primaryCounts, PRIMARY_DISPOSITIONS),
        recovery: countsObject(recoveryCounts, RECOVERY_DISPOSITIONS),
      };
    },

    toJSON() {
      return this.serialize();
    },
  };
}

export { PRIMARY_DISPOSITIONS, RECOVERY_DISPOSITIONS };
