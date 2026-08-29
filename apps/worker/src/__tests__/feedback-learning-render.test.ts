import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "../feedback-learning/canonical";
import { canonicalLedgerState, type CapacityState, type EffectiveLedger } from "../feedback-learning/ledger";
import {
  buildRunArtifacts,
  type ApprovalFreshnessProjection,
  type RenderInput,
} from "../feedback-learning/render";
import type { NormalizedFeedbackResult, Sha256 } from "../feedback-learning/types";

const SNAPSHOT_HASH = sha256("{}");
const UPDATED_AT = "2026-08-28T12:00:00.000Z";

function normalized(feedbackId: string): NormalizedFeedbackResult {
  return {
    status: "valid",
    candidateVersion: sha256(`${feedbackId}\n${UPDATED_AT}\n${SNAPSHOT_HASH}`),
    record: {
      feedbackId,
      clipId: `clip-${feedbackId}`,
      jobId: `job-${feedbackId}`,
      userId: `user-${feedbackId}`,
      verdict: "AS_IS",
      note: "Private note",
      evidenceKey: `evidence/${feedbackId}`,
      updatedAt: UPDATED_AT,
      snapshotCanonical: "{}",
      snapshotSha256: SNAPSHOT_HASH,
      jobProjectionId: `job-${feedbackId}`,
      jobPresent: true,
      transcriptPresent: true,
      segmentsIsArray: true,
      transcriptPartial: false,
      language: "en",
      clipKind: "insight",
      tier: "replay-ready",
      warnings: ["evidence_missing"],
      review: {
        title: `Title ${feedbackId}`,
        startTime: 1,
        endTime: 2,
        score: 0.8,
        transcript: `Private transcript ${feedbackId}`,
        note: "Private note",
        evidenceKey: `evidence/${feedbackId}`,
      },
    },
  };
}

function emptyLedger(): EffectiveLedger {
  return { activeDecisions: [], retiredTargetIds: [], destinationLocks: [] };
}

function emptyCapacity(): CapacityState {
  const set = () => ({
    jobCounts: new Map<string, number>(),
    userCounts: new Map<string, number>(),
    freshApprovals: [],
    staleReservations: [],
  });
  return { eval: set(), holdout: set() };
}

function renderInput(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    results: [normalized("feedback-1")],
    targetSet: "eval",
    updatedFrom: "2026-08-22T00:00:00.000Z",
    updatedTo: "2026-08-29T00:00:00.000Z",
    limit: 50,
    ledger: emptyLedger(),
    capacity: emptyCapacity(),
    approvalFreshness: [],
    ...overrides,
  };
}

function manifest(input: RenderInput = renderInput()) {
  return JSON.parse(buildRunArtifacts(input).files["run.json"].toString("utf8")) as {
    runId: string;
    optionsSha256: Sha256;
    inputSha256: Sha256;
    ledgerSha256: Sha256;
    runDigest: Sha256;
    counts: Record<string, number>;
    staleAssignments: unknown[];
  };
}

describe("buildRunArtifacts", () => {
  it("renders exactly four deterministic buffers with compact JSONL and LF contracts", () => {
    const first = buildRunArtifacts(renderInput());
    const second = buildRunArtifacts(renderInput());

    expect(Object.keys(first.files)).toEqual([
      "run.json",
      "candidates.jsonl",
      "exclusions.jsonl",
      "candidates.md",
    ]);
    for (const bytes of Object.values(first.files)) expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(first.files).toEqual(second.files);
    expect(first.status).toEqual(second.status);
    expect(first.files["run.json"].toString("utf8")).toMatch(/^\{[^\n]+\}\n$/);
    expect(first.files["candidates.jsonl"].toString("utf8")).toMatch(/^\{[^\n]+\}\n$/);
    expect(first.files["exclusions.jsonl"]).toEqual(Buffer.alloc(0));
    expect(first.files["candidates.md"].toString("utf8")).toMatch(/[^\n]\n$/);
    for (const bytes of Object.values(first.files)) expect(bytes.toString("utf8")).not.toContain("\r");
  });

  it("writes the exact run and candidate field order and count equations", () => {
    const artifacts = buildRunArtifacts(renderInput());
    const run = artifacts.files["run.json"].toString("utf8");
    const candidate = artifacts.files["candidates.jsonl"].toString("utf8");

    expect(run).toBe(
      '{"schemaVersion":1,"runId":"eval-09d54c11318ec43c","targetSet":"eval",' +
      '"updatedFrom":"2026-08-22T00:00:00.000Z","updatedTo":"2026-08-29T00:00:00.000Z",' +
      '"limit":50,"optionsSha256":"sha256:751062991b502359f0900a3cc6e19a3267d388841a194cd21fd1e369473bfaf9",' +
      '"inputSha256":"sha256:468a8ef2f2868e1fe0a541a4fff2a9e3d902b18c6a475f89ab8fa3673626960c",' +
      '"ledgerSha256":"sha256:22ad1174d4b4e9fa9da354dd4d128ccb63565e34ac7155662e696ae847c16cbf",' +
      '"runDigest":"sha256:09d54c11318ec43cfcc0d73eca32ca4721aa12829357ea160e9de366bbb745fc",' +
      '"counts":{"queried":1,"selected":1,"excluded":0,"selectedReplayReady":1,' +
      '"selectedReferenceOnly":0,"freshApprovals":0,"staleReservations":0},' +
      '"staleAssignments":[]}\n'
    );
    expect(candidate).toBe(
      '{"schemaVersion":1,"candidateVersion":"sha256:203fd43d54f777bae4ada3c4a13d79ab041320549a5c2cddbda422b735824f92",' +
      '"targetSet":"eval","feedbackId":"feedback-1","clipId":"clip-feedback-1",' +
      '"jobId":"job-feedback-1","userId":"user-feedback-1","updatedAt":"2026-08-28T12:00:00.000Z",' +
      '"snapshotSha256":"sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",' +
      '"language":"en","clipKind":"insight","tier":"replay-ready","warnings":["evidence_missing"],' +
      '"review":{"title":"Title feedback-1","startTime":1,"endTime":2,"score":0.8,' +
      '"transcript":"Private transcript feedback-1","note":"Private note",' +
      '"evidenceKey":"evidence/feedback-1"}}\n'
    );

    const parsed = manifest();
    expect(parsed.counts.queried).toBe(parsed.counts.selected + parsed.counts.excluded);
    expect(parsed.counts.selected).toBe(
      parsed.counts.selectedReplayReady + parsed.counts.selectedReferenceOnly
    );
  });

  it("derives the three hashes, digest and run ID from exact canonical projections", () => {
    const input = renderInput();
    const run = manifest(input);
    const expectedOptions = sha256(
      canonicalJson({
        schemaVersion: 1,
        targetSet: input.targetSet,
        updatedFrom: input.updatedFrom,
        updatedTo: input.updatedTo,
        limit: input.limit,
      })
    );
    const expectedInput = sha256(
      canonicalJson([
        {
          status: "valid",
          candidateVersion: (input.results[0] as Extract<NormalizedFeedbackResult, { status: "valid" }>).candidateVersion,
          record: (input.results[0] as Extract<NormalizedFeedbackResult, { status: "valid" }>).record,
        },
      ])
    );
    const expectedLedger = sha256(
      canonicalJson({
        effectiveLedger: JSON.parse(canonicalLedgerState(input.ledger)),
        approvalFreshness: [],
      })
    );
    const expectedDigest = sha256(
      canonicalJson({
        optionsSha256: expectedOptions,
        inputSha256: expectedInput,
        ledgerSha256: expectedLedger,
      })
    );

    expect(run).toMatchObject({
      optionsSha256: expectedOptions,
      inputSha256: expectedInput,
      ledgerSha256: expectedLedger,
      runDigest: expectedDigest,
      runId: `eval-${expectedDigest.slice("sha256:".length, "sha256:".length + 16)}`,
    });
  });

  it("uses zero bytes for both empty JSONL files and retains every empty Markdown section", () => {
    const artifacts = buildRunArtifacts(renderInput({ results: [] }));
    const markdown = artifacts.files["candidates.md"].toString("utf8");

    expect(artifacts.files["candidates.jsonl"]).toEqual(Buffer.alloc(0));
    expect(artifacts.files["exclusions.jsonl"]).toEqual(Buffer.alloc(0));
    expect(markdown).toBe(
      "# AS_IS learning corpus - eval-3f1112e05a86e9fa\n\n" +
      "## Summary\n\n" +
      "- Queried: 0\n" +
      "- Selected: 0\n" +
      "- Excluded: 0\n" +
      "- Selected replay-ready: 0\n" +
      "- Selected reference-only: 0\n" +
      "- Fresh approvals: 0\n" +
      "- Stale reservations: 0\n" +
      "- Exclusion invalid_row: 0\n" +
      "- Exclusion stale_review_requires_retirement: 0\n" +
      "- Exclusion already_approved: 0\n" +
      "- Exclusion already_rejected: 0\n" +
      "- Exclusion job_cap: 0\n" +
      "- Exclusion user_cap: 0\n" +
      "- Exclusion limit_reached: 0\n\n" +
      "## Stale assignments (0)\n\n" +
      "## Candidates (0)\n\n" +
      "## Exclusions (0)\n"
    );
  });

  it("is invariant to query order and hashes deterministic invalid markers", () => {
    const invalid: NormalizedFeedbackResult = {
      status: "invalid",
      invalid: {
        feedbackId: null,
        candidateVersion: null,
        reason: "invalid_row",
        detailCode: "identity_unavailable",
      },
    };
    const ordered = buildRunArtifacts(
      renderInput({ results: [invalid, normalized("feedback-a"), normalized("feedback-b")] })
    );
    const reversed = buildRunArtifacts(
      renderInput({ results: [normalized("feedback-b"), invalid, normalized("feedback-a")] })
    );
    const changedInvalid = buildRunArtifacts(
      renderInput({
        results: [
          {
            status: "invalid",
            invalid: { ...invalid.invalid, detailCode: "projection_invalid" },
          },
          normalized("feedback-a"),
          normalized("feedback-b"),
        ],
      })
    );

    expect(reversed.files).toEqual(ordered.files);
    expect(changedInvalid.files["run.json"]).not.toEqual(ordered.files["run.json"]);
    expect(changedInvalid.files["exclusions.jsonl"]).not.toEqual(
      ordered.files["exclusions.jsonl"]
    );
  });

  it("sorts stale assignments by UTF-8 feedback ID and reports requested-set capacity only", () => {
    const bmp = {
      schemaVersion: 1 as const,
      eventId: "approve-bmp",
      action: "approve" as const,
      occurredAt: "2026-08-29T10:00:00.000Z",
      candidateVersion: sha256(`\ue000\n${UPDATED_AT}\n${SNAPSHOT_HASH}`),
      feedbackId: "\ue000",
      feedbackUpdatedAt: UPDATED_AT,
      snapshotSha256: SNAPSHOT_HASH,
      clipId: "clip-bmp",
      jobId: "job-bmp",
      userId: "user-bmp",
      set: "eval" as const,
    };
    const astral = {
      ...bmp,
      eventId: "approve-astral",
      candidateVersion: sha256(`\u{10000}\n${UPDATED_AT}\n${SNAPSHOT_HASH}`),
      feedbackId: "\u{10000}",
      clipId: "clip-astral",
      jobId: "job-astral",
      userId: "user-astral",
    };
    const holdout = { ...bmp, eventId: "approve-holdout", feedbackId: "holdout", set: "holdout" as const, candidateVersion: sha256(`holdout\n${UPDATED_AT}\n${SNAPSHOT_HASH}`) };
    const ledger: EffectiveLedger = {
      activeDecisions: [astral, bmp, holdout],
      retiredTargetIds: [],
      destinationLocks: [
        { feedbackId: astral.feedbackId, set: "eval" },
        { feedbackId: bmp.feedbackId, set: "eval" },
        { feedbackId: holdout.feedbackId, set: "holdout" },
      ],
    };
    const evalStale = [
      { approval: astral, reason: "missing" as const },
      { approval: bmp, reason: "snapshot_changed" as const },
    ];
    const capacity: CapacityState = {
      eval: {
        jobCounts: new Map([[astral.jobId, 1], [bmp.jobId, 1]]),
        userCounts: new Map([[astral.userId, 1], [bmp.userId, 1]]),
        freshApprovals: [],
        staleReservations: evalStale,
      },
      holdout: {
        jobCounts: new Map([[holdout.jobId, 1]]),
        userCounts: new Map([[holdout.userId, 1]]),
        freshApprovals: [],
        staleReservations: [{ approval: holdout, reason: "missing" }],
      },
    };
    const approvalFreshness: ApprovalFreshnessProjection[] = [astral, bmp, holdout].map((item) => ({
      feedbackId: item.feedbackId,
      present: false,
      verdict: null,
      updatedAt: null,
      snapshotCanonical: null,
      snapshotSha256: null,
      staleReason: "missing",
    }));
    const currentSnapshotCanonical = "{\"changed\":true}";
    approvalFreshness[1] = {
      ...approvalFreshness[1],
      present: true,
      verdict: "AS_IS",
      updatedAt: UPDATED_AT,
      snapshotCanonical: currentSnapshotCanonical,
      snapshotSha256: sha256(currentSnapshotCanonical),
      staleReason: "snapshot_changed",
    };

    const run = manifest(renderInput({ results: [], ledger, capacity, approvalFreshness }));

    expect(run.counts).toMatchObject({ freshApprovals: 0, staleReservations: 2 });
    expect(run.staleAssignments).toEqual([
      { feedbackId: bmp.feedbackId, candidateVersion: bmp.candidateVersion, set: "eval", reason: "snapshot_changed" },
      { feedbackId: astral.feedbackId, candidateVersion: astral.candidateVersion, set: "eval", reason: "missing" },
    ]);
  });

  it("counts approvals outside the cohort and hashes every freshness outcome", () => {
    const approved = {
      schemaVersion: 1 as const,
      eventId: "approve-outside-cohort",
      action: "approve" as const,
      occurredAt: "2026-08-29T10:00:00.000Z",
      candidateVersion: sha256(`approved\n${UPDATED_AT}\n${SNAPSHOT_HASH}`),
      feedbackId: "approved",
      feedbackUpdatedAt: UPDATED_AT,
      snapshotSha256: SNAPSHOT_HASH,
      clipId: "clip-approved",
      jobId: "job-approved",
      userId: "user-approved",
      set: "eval" as const,
    };
    const ledger: EffectiveLedger = {
      activeDecisions: [approved],
      retiredTargetIds: [],
      destinationLocks: [{ feedbackId: approved.feedbackId, set: "eval" }],
    };
    const projection = (
      overrides: Partial<ApprovalFreshnessProjection> = {}
    ): ApprovalFreshnessProjection => ({
      feedbackId: approved.feedbackId,
      present: true,
      verdict: "AS_IS",
      updatedAt: UPDATED_AT,
      snapshotCanonical: "{}",
      snapshotSha256: SNAPSHOT_HASH,
      staleReason: null,
      ...overrides,
    });
    const state = (
      freshness: ApprovalFreshnessProjection,
      reason: null | "missing" | "verdict_changed" | "updated_at_changed" | "snapshot_changed"
    ): RenderInput => ({
      ...renderInput({ results: [] }),
      ledger,
      capacity: {
        eval: {
          jobCounts: new Map([[approved.jobId, 1]]),
          userCounts: new Map([[approved.userId, 1]]),
          freshApprovals: reason === null ? [approved] : [],
          staleReservations: reason === null ? [] : [{ approval: approved, reason }],
        },
        holdout: emptyCapacity().holdout,
      },
      approvalFreshness: [freshness],
    });
    const fresh = manifest(state(projection(), null));
    const changedSnapshotCanonical = "{\"changed\":true}";
    const variants = [
      state(
        projection({
          present: false,
          verdict: null,
          updatedAt: null,
          snapshotCanonical: null,
          snapshotSha256: null,
          staleReason: "missing",
        }),
        "missing"
      ),
      state(
        projection({ verdict: "EDIT", staleReason: "verdict_changed" }),
        "verdict_changed"
      ),
      state(
        projection({
          updatedAt: "2026-08-28T13:00:00.000Z",
          staleReason: "updated_at_changed",
        }),
        "updated_at_changed"
      ),
      state(
        projection({
          snapshotCanonical: changedSnapshotCanonical,
          snapshotSha256: sha256(changedSnapshotCanonical),
          staleReason: "snapshot_changed",
        }),
        "snapshot_changed"
      ),
    ];

    expect(fresh.counts).toMatchObject({ queried: 0, freshApprovals: 1, staleReservations: 0 });
    for (const variant of variants) {
      const changed = manifest(variant);
      expect(changed.ledgerSha256).not.toBe(fresh.ledgerSha256);
      expect(changed.counts).toMatchObject({ queried: 0, freshApprovals: 0, staleReservations: 1 });
    }
  });

  it("changes inputSha256 when any output-affecting normalized projection changes", () => {
    const base = normalized("feedback-1");
    if (base.status !== "valid") throw new Error("expected valid");
    const baseHash = manifest(renderInput({ results: [base] })).inputSha256;
    const changedUpdatedAt = "2026-08-28T13:00:00.000Z";
    const changedSnapshotCanonical = "{\"x\":1}";
    const changedSnapshotSha256 = sha256(changedSnapshotCanonical);
    const mutations: NormalizedFeedbackResult[] = [
      {
        ...base,
        candidateVersion: sha256(`changed\n${UPDATED_AT}\n${SNAPSHOT_HASH}`),
        record: { ...base.record, feedbackId: "changed" },
      },
      { ...base, record: { ...base.record, clipId: "changed" } },
      { ...base, record: { ...base.record, jobId: "changed" } },
      { ...base, record: { ...base.record, userId: "changed" } },
      { ...base, record: { ...base.record, note: "changed" } },
      { ...base, record: { ...base.record, evidenceKey: "changed" } },
      {
        ...base,
        candidateVersion: sha256(`feedback-1\n${changedUpdatedAt}\n${SNAPSHOT_HASH}`),
        record: { ...base.record, updatedAt: changedUpdatedAt },
      },
      {
        ...base,
        candidateVersion: sha256(`feedback-1\n${UPDATED_AT}\n${changedSnapshotSha256}`),
        record: {
          ...base.record,
          snapshotCanonical: changedSnapshotCanonical,
          snapshotSha256: changedSnapshotSha256,
        },
      },
      { ...base, record: { ...base.record, jobProjectionId: "changed" } },
      { ...base, record: { ...base.record, jobPresent: false } },
      { ...base, record: { ...base.record, transcriptPresent: false } },
      { ...base, record: { ...base.record, segmentsIsArray: false } },
      { ...base, record: { ...base.record, transcriptPartial: true } },
      { ...base, record: { ...base.record, language: "ru" } },
      { ...base, record: { ...base.record, clipKind: "story" } },
      { ...base, record: { ...base.record, tier: "reference-only" } },
      { ...base, record: { ...base.record, warnings: ["job_missing"] } },
      { ...base, record: { ...base.record, review: { ...base.record.review, title: "changed" } } },
      { ...base, record: { ...base.record, review: { ...base.record.review, startTime: 3 } } },
      { ...base, record: { ...base.record, review: { ...base.record.review, endTime: 4 } } },
      { ...base, record: { ...base.record, review: { ...base.record.review, score: 0.7 } } },
      { ...base, record: { ...base.record, review: { ...base.record.review, transcript: "changed" } } },
      { ...base, record: { ...base.record, review: { ...base.record.review, note: "changed" } } },
      { ...base, record: { ...base.record, review: { ...base.record.review, evidenceKey: "changed" } } },
    ];

    for (const changed of mutations) {
      expect(manifest(renderInput({ results: [changed] })).inputSha256).not.toBe(baseHash);
    }
  });

  it("returns a safe status with no private row or review values", () => {
    const artifacts = buildRunArtifacts(renderInput());
    const status = JSON.stringify(artifacts.status);

    expect(Object.keys(artifacts.status)).toEqual(["runId", "targetSet", "counts"]);
    expect(status).not.toContain("feedback-1");
    expect(status).not.toContain("Private");
    expect(status).not.toContain("user-");
  });
});
