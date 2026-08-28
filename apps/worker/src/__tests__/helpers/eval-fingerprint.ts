import type { AnalyzeConfig } from "../../analyze-v2/config";
import { arcAuditMaxOutputTokens } from "../../analyze-v2/arc-audit";
import { criticMaxOutputTokens } from "../../analyze-v2/critic";
import { extensionMaxOutputTokens } from "../../analyze-v2/end-extension";
import { finalizerMaxOutputTokens } from "../../analyze-v2/finalize";

/**
 * Engine-config fingerprint stored next to every eval fixture (meta.json).
 *
 * WHY THIS EXISTS
 * ---------------
 * replay-client's requestKey hashes model + system + user only. That is the
 * right identity for a *prompt*, but it is NOT the identity of the *run*: knobs
 * that change what the model is allowed to do while answering (output cap,
 * reasoning effort) leave the key untouched. When the critic output budget was
 * resized, both fixtures kept serving responses captured under the old,
 * starved budget and the harness stayed green - it certified an already-fixed
 * bug as correct. A fingerprint turns that silent pass into a loud failure
 * without putting the cap into the hash (which would force a paid re-record on
 * every budget tweak, since the hash is per-request).
 *
 * WHAT IS IN IT - the knobs that decide what the LLM is asked and how it may
 * answer:
 *   scanModel / criticModel      which model answers. Both are inside the
 *                                requestKey too, but a mismatch there surfaces
 *                                as a cryptic "unrecorded request <hex>"; here
 *                                it names the knob.
 *   criticModelFallback          NOT reliably in the hash: it only appears in a
 *                                recording if the fallback path actually fired.
 *                                Change it after a clean recording and nothing
 *                                anywhere notices.
 *   reasoningEffort              invisible to the hash and the dominant term in
 *                                critic token usage - raising it re-creates the
 *                                truncation cascade the budget exists to
 *                                prevent (see critic.ts).
 *   criticBatchSize              decides how candidates are grouped into
 *                                prompts, so it changes both the prompt text
 *                                and the token demand of every critic call.
 *   criticMaxOutputTokens*       the exact bug above. Derived from the function
 *                                rather than from the raw constants so that a
 *                                change to the FORMULA is caught as well as a
 *                                change to either constant.
 *   finalizerEnabled             the worst of the lot, and the reason the
 *                                finalizer knobs were added here the moment the
 *                                stage was wired in. Turning the finalizer OFF
 *                                does not produce an unrecorded request - it
 *                                produces NO request - so replay stays green
 *                                while shipping a different, un-judged set.
 *                                That is a false MATCH, exactly what this file
 *                                exists to kill.
 *   finalizerModel               same argument as criticModel: it is inside the
 *                                requestKey, but a mismatch surfaces there as
 *                                an opaque hex, and here as the knob's name.
 *   finalizerMaxOutputTokens*    same argument as the critic budget, only worse:
 *                                this call cannot split a batch, so starvation
 *                                costs the whole stage rather than one batch,
 *                                and the numbers behind the formula are marked
 *                                ESTIMATED in finalize.ts - i.e. they are
 *                                expected to move once measured.
 *   endExtensionEnabled          finalizerEnabled's argument, verbatim: off
 *                                makes NO request, so the hash cannot notice it.
 *                                Sharper here, because this stage is the one
 *                                that ships dark. Every fixture in the repo was
 *                                recorded with it off, so the direction that
 *                                matters is a LIVE stage replaying against a
 *                                dark recording: the ends move, the snapshot
 *                                moves with them, and without this key nothing
 *                                says whether it moved because the stage worked
 *                                or because the recording predates it. That is
 *                                the one question the measurement asks.
 *   endExtensionWindowSec        bounds what the model is SHOWN and what it may
 *                                choose. It changes prompt text like the
 *                                windowing knobs below - but unlike them it can
 *                                shrink until NO clip has anywhere to go, and
 *                                then the stage makes no request at all and the
 *                                hash has nothing to fail on. A knob that can
 *                                silence the call belongs on finalizerEnabled's
 *                                side of the line, not finalizerHeadroom's.
 *   endExtensionMaxOutputTokens* the critic-budget bug again, and this stage has
 *                                no truncation retry at all - a starved cap
 *                                costs the whole stage for the job. Replay is
 *                                blind to it by construction: the recorded
 *                                answer is served in full whatever the cap says,
 *                                so a budget that would truncate in production
 *                                replays green. end-extension.ts marks both
 *                                constants ESTIMATED, NOT MEASURED and asks for
 *                                a re-measure from the first real run, i.e. they
 *                                are expected to move.
 *   arcAuditEnabled              finalizerEnabled's/endExtensionEnabled's
 *                                argument, verbatim: off makes NO request, so
 *                                the hash cannot notice it. Every fixture in
 *                                the repo was recorded with it off, same as
 *                                endExtensionEnabled, for the same reason.
 *   arcAuditBatchSize            decides how clips are grouped into arc-audit
 *                                prompts, so it changes both the prompt text
 *                                (already in the request hash) and the token
 *                                demand of every call - named here for the
 *                                same clarity reason criticBatchSize is.
 *   arcAuditMaxOutputTokens*     the critic-budget bug a third time, and this
 *                                stage has NO retry of any kind (not even the
 *                                critic's own omission retry - spec 2026-08-10
 *                                task 2) - a starved cap costs a whole batch of
 *                                clips as `unaudited` with no second chance.
 *                                arc-audit.ts marks both constants PROVISIONAL,
 *                                pending the M5 ladder measurement, i.e. they
 *                                are expected to move.
 *   startExtensionEnabled        whether extendClipStarts (task 3) ran at all.
 *                                Unlike every other *Enabled key above, this
 *                                stage makes NO REQUEST OF ITS OWN in either
 *                                state - it is pure application of a pointer
 *                                arc-audit already asked for and gated - so
 *                                the "off makes no request" argument does not
 *                                apply to IT directly. It is here anyway for
 *                                the reason finalizerEnabled is: responses.json
 *                                is one shared pool across every variant of a
 *                                fixture, and turning this stage off during
 *                                replay does not go MISSING, it goes UNUSED -
 *                                the finalizer would silently be asked about
 *                                the narrower, un-widened clip set instead of
 *                                the wider one a "start-extension" recording
 *                                describes, and if the base run's own
 *                                (narrower) finalizer answer for that same
 *                                clip id happens to already be sitting in the
 *                                same responses.json - which it does, every
 *                                time, because base is recorded first - the
 *                                replay finds a "valid" answer and stays green
 *                                while silently describing a different engine.
 *                                No *MaxOutputTokens pair exists for it, for
 *                                the same reason: nothing here is a token
 *                                budget for a call this stage never makes.
 *   endExtensionHintsEnabled     whether the HINT-DRIVEN half of end-extension
 *                                (task 4) may add a clip to the offered set.
 *                                Narrower than endExtensionEnabled's own
 *                                argument: whenever a hint actually renders
 *                                (buildExtensionUser's AUDIT NOTE line), the
 *                                user prompt for that clip differs from any
 *                                un-hinted recording, and the request hash
 *                                already fails loudly on its own - no key is
 *                                needed for THAT case. It is here for the
 *                                narrower boundary case start-extension's own
 *                                key exists for: turning this switch on can
 *                                take the stage from "neither switch is on,
 *                                skip immediately, no request at all" to
 *                                "a request now happens" purely via clips whose
 *                                hint happens to add nothing new to compare
 *                                against (e.g. a clip already in the
 *                                self-motivated offered set, or one whose
 *                                hinted render coincides with an answer
 *                                already sitting in the shared responses.json
 *                                pool) - the same false-MATCH shape
 *                                finalizerEnabled and startExtensionEnabled
 *                                both exist to close. No *MaxOutputTokens pair
 *                                exists for it: this key does not change the
 *                                CALL'S shape, only which clips are IN it, and
 *                                extensionMaxOutputTokens already prices off
 *                                the offered count returned by the stage
 *                                itself.
 *
 *   longClipsEnabled              finalizerEnabled's/arcAuditEnabled's
 *                                argument again: off makes the long-clip
 *                                policy in index.ts a no-op (no clip is ever
 *                                marked `overLength` in the first place), so
 *                                the request hash cannot notice it turning on
 *                                - and startExtensionEnabled's own narrower
 *                                argument applies too, since this key changes
 *                                no request of ITS OWN either: a blessed clip
 *                                shipping wide changes only which clip range
 *                                the FINALIZER is handed (plus the LENGTH
 *                                EXCEPTION line in its prompt), the same
 *                                shared-responses.json false-match risk
 *                                startExtensionEnabled exists to close.
 *   longClipMaxSec               bounds the DEFERRAL in snap.ts, not what any
 *                                model is shown - closer to
 *                                startExtensionWindowSec's role than
 *                                endExtensionWindowSec's. It earns a
 *                                fingerprint key anyway (unlike
 *                                startExtensionWindowSec) because it can
 *                                SILENCE the effect of `longClipsEnabled`
 *                                being on: shrunk to `cfg.maxSec` or below, no
 *                                clip is ever marked `overLength`, no LENGTH
 *                                EXCEPTION line ever renders, and a recording
 *                                made at a materially different
 *                                `longClipMaxSec` replays byte-identical - the
 *                                exact silent-match shape `endExtensionWindowSec`
 *                                was added to close. No *MaxOutputTokens pair
 *                                exists for it: no call's shape depends on it.
 *
 *   arcFinalizerNotesEnabled       whether a flagged clip's finalizer block may
 *                                carry an AUDIT NOTE line (spec 2026-08-10 task
 *                                6) - endExtensionHintsEnabled's own narrower
 *                                argument, verbatim: whenever a note actually
 *                                renders, the finalizer's user prompt differs
 *                                from any note-less recording and the request
 *                                hash already fails loudly on its own, no key
 *                                needed for THAT case. It is here for the same
 *                                narrower boundary this key's siblings all
 *                                close: turning the switch on can take a run
 *                                from "no clip on this fixture is flagged (or
 *                                arcAuditEnabled is off), so the prompt never
 *                                differs, no request at all changes" to "a
 *                                request now differs" purely via which clips
 *                                happen to carry `ok:false` flags - the same
 *                                false-MATCH shape finalizerEnabled,
 *                                startExtensionEnabled and
 *                                endExtensionHintsEnabled all exist to close.
 *                                No-ops without `arcAuditEnabled` too, the same
 *                                doubling every audit consumer in this engine
 *                                uses. No *MaxOutputTokens pair exists for it:
 *                                this key does not change the finalizer call's
 *                                token budget (finalizerMaxOutputTokens prices
 *                                off clip COUNT only), only whether a line is
 *                                present inside clips already being sent.
 *
 *   scanWindowBudget              which node spans buildScanWindows may count
 *                                toward the window/overlap budget: word-bearing
 *                                nodes only ("speech", today's default) or
 *                                every node including opaque ("source") - spec
 *                                2026-08-11 "Scan recall remedy". This is the
 *                                ONE windowing knob that earns a key despite
 *                                the "windowing knobs are out" rule below, for
 *                                the same reason endExtensionWindowSec and
 *                                longClipMaxSec do: it can produce a FALSE
 *                                MATCH instead of a loud stale-request
 *                                failure. The two budgets are mathematically
 *                                IDENTICAL whenever a source has zero opaque
 *                                nodes (sourceSec == speechSec exactly then -
 *                                see scan-windows.test.ts's own boundary
 *                                case): on such a source the window layout,
 *                                and therefore every scanner request key, is
 *                                byte-identical under both settings, so the
 *                                request hash has nothing to fail on and a
 *                                fixture recorded under one budget would
 *                                replay green under the other by coincidence
 *                                rather than by proof. Any source WITH opaque
 *                                nodes (every real fixture in this repo)
 *                                already changes every downstream request key
 *                                on its own and needs no key here for THAT
 *                                case - named anyway, for the same clarity
 *                                reason criticBatchSize is despite being
 *                                mostly redundant with the hash there too.
 *
 *   scanPasses                     how many times `runScanner` asks the SAME
 *                                window the SAME prompt (spec 2026-08-11
 *                                "Scan recall remedy", Phase B). This is the
 *                                sharpest case in the whole file for why a
 *                                fingerprint key exists independent of the
 *                                request hash: the hash is
 *                                sha256(model, system, user), and two passes
 *                                at passes>1 send that EXACT SAME request, so
 *                                they share ONE key. A fixture "recorded" at
 *                                passes>1 does not capture two draws - it
 *                                captures one answer that replay then serves
 *                                to BOTH passes, and the union of a sample
 *                                with itself is silently just that sample.
 *                                That is a lie by construction, not a
 *                                degraded measurement, and the whole point of
 *                                Phase B (union N independent draws to fight
 *                                scanner sampling variance) becomes
 *                                unmeasurable while looking like it replayed
 *                                fine. Unlike scanWindowBudget, this knob
 *                                does NOT coincide with the request key on
 *                                some sources and diverge on others - it
 *                                ALWAYS coincides, on every source, the
 *                                moment passes>1, which is why it cannot be
 *                                left out on the "windowing knobs are covered
 *                                by their own request key" theory the general
 *                                rule below relies on. Multi-pass is
 *                                deliberately not recordable and not a
 *                                variant (see config.ts's own comment on this
 *                                knob for the record foot-gun in full); this
 *                                key exists so a fixture cannot silently
 *                                drift onto a config claiming otherwise.
 *
 *   arcDownrankEnabled            whether the unrepairable-flag downrank
 *                                policy (task 7) may DROP a clip before the
 *                                finalizer ever sees it. finalizerEnabled's/
 *                                arcAuditEnabled's argument again: off makes
 *                                the block in index.ts a no-op (afterArcDownrank
 *                                stays identical to beforeFinalize), so the
 *                                request hash cannot notice it turning on -
 *                                and startExtensionEnabled's own narrower
 *                                argument applies too, since a dropped clip
 *                                changes no request of ITS OWN either: it
 *                                changes only which clips the FINALIZER is
 *                                handed (fewer CLIP blocks in its prompt),
 *                                the same shared-responses.json false-match
 *                                risk startExtensionEnabled/longClipsEnabled
 *                                both exist to close - a finalizer prompt
 *                                missing one clip could, in principle, still
 *                                collide with an answer already sitting in
 *                                the pool for a narrower set the base run
 *                                also produced.
 *   arcDownrankPenalty2/          the exact "can silence the stage" case this
 *   arcDownrankPenalty1           file already documents for longClipMaxSec/
 *                                endExtensionWindowSec, sharpened: EITHER
 *                                penalty at 0 makes its own tier contribute
 *                                nothing to the drop decision (config.ts's own
 *                                doc comment - arcDownrankPenalty1 SHIPS at
 *                                0 by default for exactly this reason), so a
 *                                fixture recorded at one penalty value would
 *                                replay byte-identical under a different one
 *                                whenever no clip's standing count crosses the
 *                                tier the moved penalty would have changed.
 *                                Neither penalty changes any request's text or
 *                                shape - both bound what CODE does with an
 *                                answer already on disk - so this is the
 *                                windowing-knob argument's mirror image: not
 *                                "changes the request but the hash already
 *                                covers it," but "changes nothing the hash can
 *                                see at all AND can silently change the
 *                                shipped set," which is precisely the
 *                                combination this file exists to catch. No
 *                                *MaxOutputTokens pair exists for either: no
 *                                call's shape depends on them, since this
 *                                stage makes no call of its own.
 *
 * startExtensionWindowSec is NOT here, unlike endExtensionWindowSec - the
 * asymmetry is deliberate. It bounds a GATE inside arc-audit.ts (whether a
 * `fix_start_node` pointer is close enough to keep), never what the arc-audit
 * MODEL is shown or asked: the prompt's CONTEXT BEFORE/AFTER padding is the
 * fixed CONTEXT_BEFORE/CONTEXT_AFTER window the critic already uses, not this
 * knob. So moving it changes what the code does with an answer already on
 * disk - the scoring/gating carve-out below - not what was asked, so no
 * request goes stale and no re-record is owed.
 *
 * finalizerHeadroom is deliberately NOT here: it changes how many clips reach
 * the prompt, so it changes the prompt text and the requestKey already fails
 * loudly on its own - the same reason the windowing knobs are out. It cannot
 * silence the call, which is what separates it from endExtensionWindowSec.
 *
 * sceneGapSec is NOT here either, and it is the closest call in this file: it
 * also bounds the offered range and can also empty a window. It stays out
 * because it is not a knob about what the model may do - it is a measured
 * property of the SOURCE (the hole a hard cut leaves, scene-gaps.ts), inert on
 * every podcast fixture by construction, and moving it is a re-measurement that
 * has to be argued from the transcripts rather than a configuration choice.
 *
 * WHAT IS DELIBERATELY OUT:
 *   - Scoring/gating/snapping knobs (scoreThreshold, softCap, gap*, hardMinSec,
 *     ...). They change what the engine does WITH the answers, never what it
 *     asks. A change there must show up as a snapshot diff - that is the
 *     harness working. Fingerprinting them would demand a paid re-record for
 *     every threshold tweak, i.e. cry wolf.
 *   - Windowing/candidate caps (scanWindowSec, criticMaxCandidates, ...). They
 *     do change prompt text, but that already changes the requestKey, so a
 *     stale fixture fails loudly on its own. Adding them buys nothing and adds
 *     re-record pressure. `scanWindowBudget` is the one exception, in the list
 *     above rather than here, because it can COINCIDE with the request key
 *     unchanged instead of always moving it - see its own entry for why.
 *   - CRITIC_CONCURRENCY / maxConcurrency: scheduling only. Same requests, same
 *     caps, same answers - replay does not even observe it.
 */
export interface EngineFingerprint {
  scanModel: string;
  criticModel: string;
  criticModelFallback: string;
  reasoningEffort: string;
  criticBatchSize: number;
  /** criticMaxOutputTokens(0) - the flat part of the critic output budget. */
  criticMaxOutputTokensBase: number;
  /** Marginal cap per extra candidate in a critic batch. */
  criticMaxOutputTokensPerCandidate: number;
  /** Whether the FINALIZE LLM pass ran at all. Off makes no request, so the
   *  request hash cannot notice it. */
  finalizerEnabled: boolean;
  finalizerModel: string;
  /** finalizerMaxOutputTokens(0) - the flat part of the finalizer budget. */
  finalizerMaxOutputTokensBase: number;
  /** Marginal cap per extra clip in the single finalizer call. */
  finalizerMaxOutputTokensPerClip: number;
  /** Whether the END-EXTENSION LLM pass ran at all. Off makes no request, so the
   *  request hash cannot notice it. */
  endExtensionEnabled: boolean;
  /** How far past its current end a clip may reach - the offered node list, and
   *  at zero, no offer at all. */
  endExtensionWindowSec: number;
  /** extensionMaxOutputTokens(0) - the flat part of the extension budget. */
  endExtensionMaxOutputTokensBase: number;
  /** Marginal cap per extra clip in the single extension call. */
  endExtensionMaxOutputTokensPerClip: number;
  /** Whether the ARC-AUDIT LLM pass ran at all. Off makes no request, so the
   *  request hash cannot notice it - the same argument as endExtensionEnabled. */
  arcAuditEnabled: boolean;
  /** Clips per arc-audit batch call - changes prompt text and token demand. */
  arcAuditBatchSize: number;
  /** arcAuditMaxOutputTokens(0) - the flat part of the arc-audit budget. */
  arcAuditMaxOutputTokensBase: number;
  /** Marginal cap per extra clip in one arc-audit batch call. */
  arcAuditMaxOutputTokensPerClip: number;
  /** Whether extendClipStarts (task 3) ran at all. Unlike every other
   *  *Enabled key above, this stage makes no request in either state - see
   *  the doc comment above for why it is still in here (the shared-
   *  responses.json false-match risk, finalizerEnabled's own argument). */
  startExtensionEnabled: boolean;
  /** Whether the HINT-DRIVEN half of end-extension (task 4) may add clips to
   *  the offered set - independent of endExtensionEnabled, the pre-existing
   *  self-motivated switch. See the doc comment above for the narrower false-
   *  match boundary this key closes. */
  endExtensionHintsEnabled: boolean;
  /** Whether the long-clip policy (task 5) may ship an arc-audit-blessed
   *  overLength clip wide instead of compressing it. See the doc comment
   *  above for why this earns a key despite making no request of its own. */
  longClipsEnabled: boolean;
  /** Ceiling for a blessed over-length clip, seconds. See the doc comment
   *  above for the silent-match risk this key exists to close. */
  longClipMaxSec: number;
  /** Whether a flagged clip's finalizer block may carry an AUDIT NOTE line
   *  (task 6). See the doc comment above for the narrower false-match
   *  boundary this key closes - the same shape endExtensionHintsEnabled's
   *  own key exists for. */
  arcFinalizerNotesEnabled: boolean;
  /** Whether the unrepairable-flag downrank policy (task 7) may drop a clip
   *  before the finalizer sees it. See the doc comment above for why this
   *  earns a key despite making no request of its own - the same
   *  shared-responses.json false-match risk startExtensionEnabled and
   *  longClipsEnabled exist to close. */
  arcDownrankEnabled: boolean;
  /** Changes finalizer input without a request of its own, so replay records
   *  the switch explicitly. */
  standaloneFilterEnabled: boolean;
  /** Score penalty for a clip with 2+ standing arc-audit axes. See the doc
   *  comment above for the "can silence the stage" risk this key exists to
   *  close - the same shape endExtensionWindowSec/longClipMaxSec document. */
  arcDownrankPenalty2: number;
  /** Score penalty for a clip with exactly 1 standing arc-audit axis. Ships
   *  at 0 by default (config.ts), which is itself the silencing case this
   *  key exists to catch. */
  arcDownrankPenalty1: number;
  /** Which node spans buildScanWindows may count toward the window/overlap
   *  budget - "speech" (word-bearing only, today's default) or "source"
   *  (every node, opaque included). See the doc comment above for why this
   *  windowing knob gets a key despite the general rule against them: the
   *  two coincide byte-for-byte on a source with zero opaque nodes. */
  scanWindowBudget: "speech" | "source";
  /** How many identical-prompt passes `runScanner` makes per window (spec
   *  2026-08-11 "Scan recall remedy", Phase B). See the doc comment above for
   *  why this earns a key despite being a "windowing knob is covered by its
   *  own request key" case in every other instance: at passes>1 the request
   *  key does NOT change (identical prompt), so a stale recording would
   *  replay green while silently proving nothing about the union. */
  scanPasses: number;
}

export function computeFingerprint(cfg: AnalyzeConfig): EngineFingerprint {
  const base = criticMaxOutputTokens(0);
  const finalizerBase = finalizerMaxOutputTokens(0);
  const extensionBase = extensionMaxOutputTokens(0);
  const arcAuditBase = arcAuditMaxOutputTokens(0);
  return {
    scanModel: cfg.scanModel,
    criticModel: cfg.criticModel,
    criticModelFallback: cfg.criticModelFallback,
    reasoningEffort: cfg.reasoningEffort,
    criticBatchSize: cfg.criticBatchSize,
    criticMaxOutputTokensBase: base,
    criticMaxOutputTokensPerCandidate: criticMaxOutputTokens(1) - base,
    finalizerEnabled: cfg.finalizerEnabled,
    finalizerModel: cfg.finalizerModel,
    finalizerMaxOutputTokensBase: finalizerBase,
    finalizerMaxOutputTokensPerClip: finalizerMaxOutputTokens(1) - finalizerBase,
    endExtensionEnabled: cfg.endExtensionEnabled,
    endExtensionWindowSec: cfg.endExtensionWindowSec,
    endExtensionMaxOutputTokensBase: extensionBase,
    endExtensionMaxOutputTokensPerClip: extensionMaxOutputTokens(1) - extensionBase,
    arcAuditEnabled: cfg.arcAuditEnabled,
    arcAuditBatchSize: cfg.arcAuditBatchSize,
    arcAuditMaxOutputTokensBase: arcAuditBase,
    arcAuditMaxOutputTokensPerClip: arcAuditMaxOutputTokens(1) - arcAuditBase,
    startExtensionEnabled: cfg.startExtensionEnabled,
    endExtensionHintsEnabled: cfg.endExtensionHintsEnabled,
    longClipsEnabled: cfg.longClipsEnabled,
    longClipMaxSec: cfg.longClipMaxSec,
    arcFinalizerNotesEnabled: cfg.arcFinalizerNotesEnabled,
    arcDownrankEnabled: cfg.arcDownrankEnabled,
    standaloneFilterEnabled: cfg.standaloneFilterEnabled,
    arcDownrankPenalty2: cfg.arcDownrankPenalty2,
    arcDownrankPenalty1: cfg.arcDownrankPenalty1,
    scanWindowBudget: cfg.scanWindowBudget,
    scanPasses: cfg.scanPasses,
  };
}

export interface FingerprintComparison {
  /** Knobs recorded with a different value than the current config has. */
  mismatches: string[];
  /** Knobs the recording predates - unknown, not proven stale. */
  unrecorded: string[];
  /**
   * Knobs the recording names that the fingerprint no longer has - stale
   * provenance, not unknown provenance, so callers FAIL on this rather than warn.
   *
   * A RENAME is what needs it, and a rename is the one edit that produces
   * nothing to look at otherwise. `mismatches` iterates the CURRENT keys, so the
   * old name is invisible to it; the new name lands in `unrecorded`, which only
   * warns. Between them a fixture recorded under the old knob replays green
   * against a config that sets the renamed one differently - the false MATCH
   * this file exists to prevent, arriving through the one door it did not watch.
   *
   * Deleting a knob outright lands here too, and correctly: a recording naming a
   * knob nobody can evaluate is provenance that cannot be checked, and the fix
   * is the same re-record either way.
   */
  stale: string[];
}

export function compareFingerprints(
  recorded: Partial<EngineFingerprint>,
  current: EngineFingerprint
): FingerprintComparison {
  const mismatches: string[] = [];
  const unrecorded: string[] = [];
  for (const key of Object.keys(current) as Array<keyof EngineFingerprint>) {
    if (!(key in recorded) || recorded[key] === undefined) {
      unrecorded.push(key);
      continue;
    }
    if (recorded[key] !== current[key]) {
      mismatches.push(
        `${key}: recorded ${JSON.stringify(recorded[key])}, current ${JSON.stringify(current[key])}`
      );
    }
  }
  // The other direction, which the loop above cannot see by construction.
  const stale = Object.keys(recorded).filter(
    (key) =>
      (recorded as Record<string, unknown>)[key] !== undefined && !(key in current)
  );
  return { mismatches, unrecorded, stale };
}

/**
 * Throws when the recording was made under a materially different engine
 * config; warns when provenance is simply unknown.
 *
 * A missing meta.json (or a key added to the fingerprint after the recording)
 * WARNS instead of failing. The failure this whole mechanism exists to kill is
 * a false MATCH - the harness asserting "same config" when it was not. Absence
 * of a fingerprint asserts nothing, and hard-failing on it would red the suite
 * for every fixture that predates this file and would make adding a knob a
 * paid-re-record event for all existing fixtures. eval-record.ts always writes
 * meta.json now, so the warn path shrinks to zero on the next recording of any
 * fixture - and both fixtures in the repo carry one today.
 *
 * A knob the recording names that no longer EXISTS is the opposite case and
 * throws: absence of a value asserts nothing, but a value nobody can evaluate
 * asserts something unverifiable. See FingerprintComparison.stale for the rename
 * this is really about.
 */
export function assertFingerprintMatches(
  fixtureName: string,
  recorded: Partial<EngineFingerprint> | null,
  current: EngineFingerprint,
  warn: (message: string) => void = console.warn
): void {
  if (recorded === null) {
    warn(
      `[eval] fixture "${fixtureName}" has no meta.json engine fingerprint - ` +
        `cannot verify it was recorded on the current config. Re-record it with eval-record.ts to fix.`
    );
    return;
  }
  const { mismatches, unrecorded, stale } = compareFingerprints(recorded, current);
  if (unrecorded.length > 0) {
    warn(
      `[eval] fixture "${fixtureName}" fingerprint predates ${unrecorded.length} knob(s) ` +
        `[${unrecorded.join(", ")}] - those are unverified. Re-record to fix.`
    );
  }
  // Both failures at once, because a rename produces one of each and reporting
  // half of it is how the rename slipped through in the first place.
  const problems = [
    ...mismatches,
    ...stale.map(
      (key) =>
        `${key}: recorded ${JSON.stringify(
          (recorded as Record<string, unknown>)[key]
        )}, and the fingerprint has no such knob today - renamed or removed, so ` +
        `this recording's only statement about it can no longer be checked`
    ),
  ];
  if (problems.length > 0) {
    throw new Error(
      `fixture "${fixtureName}" was recorded under a DIFFERENT engine config, so its responses no ` +
        `longer describe what the current engine would ask or be allowed to answer:\n` +
        problems.map((m) => `  - ${m}`).join("\n") +
        `\nA green run here would be a lie. Either revert the knob(s) above, or re-record the ` +
        `fixture:\n  docker compose exec worker-analyze sh -c "cd /app/apps/worker && ` +
        `npx tsx src/scripts/eval-record.ts <jobId> ${fixtureName}"`
    );
  }
}
