import type {
  CandidatePrimaryDisposition,
  CandidateRecoveryDisposition,
} from "./types";

const PRIMARY_DISPOSITIONS: readonly CandidatePrimaryDisposition[] = [
  "not_selected_for_critic",
  "critic_rejected",
  "evidence_rejected",
  "snap_rejected",
  "selection_not_chosen",
  "arc_rejected",
  "post_boundary_rejected",
  "standalone_rejected",
  "finalizer_rejected",
  "shipped",
];

const RECOVERY_DISPOSITIONS: readonly CandidateRecoveryDisposition[] =
  PRIMARY_DISPOSITIONS.filter(
    (disposition): disposition is CandidateRecoveryDisposition =>
      disposition !== "not_selected_for_critic",
  );

type CountMap<T extends string> = Partial<Record<T, number>>;

export interface CandidateTraceSerialized {
  primary: CountMap<CandidatePrimaryDisposition>;
  recovery: CountMap<CandidateRecoveryDisposition>;
}

export interface CandidateTrace {
  terminatePrimary(id: string, disposition: CandidatePrimaryDisposition): void;
  terminateRecovery(id: string, disposition: CandidateRecoveryDisposition): void;
  summaryPrimary(): CountMap<CandidatePrimaryDisposition>;
  summaryRecovery(): CountMap<CandidateRecoveryDisposition>;
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

function countsObject<T extends string>(counts: Map<T, number>): CountMap<T> {
  const result: CountMap<T> = {};
  for (const [disposition, count] of counts) result[disposition] = count;
  return result;
}

/**
 * Create an in-memory, append-only accounting trace for one candidate set.
 * IDs are the only candidate identity retained here: callers must pass any
 * range/type details to count-only telemetry separately, keeping transcript,
 * user, media, and model prose out of serialization by construction.
 */
export function createCandidateTrace(
  candidateIds: readonly string[],
): CandidateTrace {
  const ids = new Set<string>();
  for (const id of candidateIds) {
    if (typeof id !== "string" || id.length === 0) fail("invalid_candidate");
    if (ids.has(id)) fail("duplicate_candidate");
    ids.add(id);
  }

  const primary = new Map<string, CandidatePrimaryDisposition>();
  const recovery = new Map<string, CandidateRecoveryDisposition>();
  const primaryCounts = new Map<CandidatePrimaryDisposition, number>();
  const recoveryCounts = new Map<CandidateRecoveryDisposition, number>();

  const requireKnown = (id: string): void => {
    if (!ids.has(id)) fail("unknown_candidate");
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

    terminateRecovery(id, disposition) {
      requireKnown(id);
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
      return countsObject(primaryCounts);
    },

    summaryRecovery() {
      return countsObject(recoveryCounts);
    },

    serialize() {
      return {
        primary: countsObject(primaryCounts),
        recovery: countsObject(recoveryCounts),
      };
    },

    toJSON() {
      return {
        primary: countsObject(primaryCounts),
        recovery: countsObject(recoveryCounts),
      };
    },
  };
}

export { PRIMARY_DISPOSITIONS, RECOVERY_DISPOSITIONS };
