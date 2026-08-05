import OpenAI from "openai";
import type { TranscriptionResult } from "@clipclap/shared";
import { loadAnalyzeConfig, type AnalyzeConfig } from "./config";
import { buildSentenceGraph } from "./sentence-graph";
import { runScanner } from "./scanner";
import { criticBudget, mergeCandidates, selectCriticCandidates, sourceSeconds } from "./candidates";
import { AnalyzeTechnicalError, runCritic, repairCopy } from "./critic";
import { snapNodes } from "./snap";
import {
  EVIDENCE_BOUNDARY_SLACK_NODES,
  evidenceGate,
  regroundCopy,
  snippetFallbackCopy,
  lexicalOverlap,
} from "./gates";
import { dominantScript, isoToLanguageName, scriptMismatch } from "./language";
import { selectAndOrder } from "./select";
import { extendClipEnds } from "./end-extension";
import { finalizeClips } from "./finalize";
import { detectTeaserRegion, isInTeaserRegion } from "./teaser";
import { newUsage } from "./llm";
import type {
  MergedCandidate,
  SnappedClip,
  V2Highlight,
  V2Result,
} from "./types";

const DEGENERATE_MIN_WORDS = 5;
const DEGENERATE_MIN_SPEECH_SEC = 4;
const TINY_MAX_WORDS = 24;

export interface AnalyzeV2Options {
  client?: OpenAI;
  cfg?: AnalyzeConfig;
  transcriptPartial?: boolean;
  /** Test hook - forwarded to scanner/critic. */
  retryDelayMs?: number;
}

export async function analyzeHighlightsV2(
  transcription: TranscriptionResult,
  options: AnalyzeV2Options = {}
): Promise<V2Result> {
  const cfg = options.cfg ?? loadAnalyzeConfig();
  const client =
    options.client ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const usage = newUsage();
  const partial = options.transcriptPartial ?? false;

  const wordCount = transcription.segments.reduce(
    (sum, s) => sum + (s.words?.length ?? 0),
    0
  );
  const nodes = buildSentenceGraph(transcription.segments, cfg);
  const speechSec = nodes
    .filter((n) => n.hasWords)
    .reduce((sum, n) => sum + (n.end - n.start), 0);

  // 0. degenerate guard - zero LLM cost
  if (
    wordCount < DEGENERATE_MIN_WORDS ||
    speechSec < DEGENERATE_MIN_SPEECH_SEC ||
    nodes.every((n) => !n.hasWords)
  ) {
    return {
      highlights: [],
      noClipsReason: "NO_USABLE_SPEECH",
      telemetry: { wordCount, speechSec, path: "degenerate" },
      usage,
    };
  }

  // Legacy transcripts (pre-V2) carry no language; fall back to the transcript's
  // dominant script so a Russian video does not get English-prompted copy.
  const languageIso =
    transcription.language ?? scriptFallbackIso(transcription.text);
  let candidates: MergedCandidate[];
  let scannerTelemetry: Record<string, unknown> = {};

  if (wordCount <= TINY_MAX_WORDS) {
    // tiny path: the whole transcript is one candidate, no scanner
    candidates = [
      {
        id: "c0",
        startNode: 0,
        endNode: nodes.length - 1,
        payoffNode: nodes.length - 1,
        interest: 0.5,
        type: "other",
        windowIndex: 0,
      },
    ];
    scannerTelemetry = { path: "tiny" };
  } else {
    const scan = await runScanner(client, usage, nodes, cfg, {
      retryDelayMs: options.retryDelayMs,
    });

    // A dead window costs recall (runScanner's contract); EVERY window dead is
    // the analysis models being unavailable, which is a technical failure, not
    // "this video has no good moments". The distinction is the user's quota:
    // a DONE 0-clip job burns their minutes (usage sums every job that is not
    // FAILED), while a FAILED one leaves the quota untouched and BullMQ retries
    // it. Never ship silent emptiness we never actually judged.
    const { windowsTotal, windowsFailed } = scan.telemetry;
    if (windowsTotal > 0 && windowsFailed === windowsTotal) {
      throw new AnalyzeTechnicalError(
        `scanner failed on all ${windowsTotal} windows (${windowsFailed}/${windowsTotal} windows) - analysis models unavailable`
      );
    }

    const merged = mergeCandidates(scan.candidates, nodes, cfg);
    // Intro montage fragments quote later speech verbatim and are truncated by
    // the source editor, so every clean-start/clean-end guard passes on them.
    // Dropping them HERE - before stratified selection, not after the critic -
    // is what makes it worth doing: perWindowMinCandidates guarantees the first
    // window a share of the critic budget, so a montage would otherwise be
    // guaranteed to spend it on bait (spec 2026-07-24 §1.1, §4.1).
    //
    // The montage is detected ONCE, as a region of the video, and candidates
    // are dropped by where they start - see teaser.ts for why per-candidate
    // similarity was measured unable to do this job.
    //
    // The region is published whether or not it fired, because a filter that
    // deletes candidates leaving no trace makes its own false positives
    // unfalsifiable: nobody ever reports the clip that was never made. A region
    // that ended at 90s on a 10-minute video is a bug you can SEE in a job
    // record. Seconds travel with each dropped id for the same reason - in a
    // production log "c2" alone says nothing, and the first question about a
    // drop is always "what did we cut?".
    const region = detectTeaserRegion(nodes, cfg);
    const teaserDrops: Array<{ id: string; startSec: number; endSec: number }> = [];
    const withoutTeasers = merged.filter((c) => {
      if (!isInTeaserRegion(region, nodes[c.startNode].start)) return true;
      teaserDrops.push({
        id: c.id,
        startSec: Math.round(nodes[c.startNode].start * 10) / 10,
        endSec: Math.round(nodes[c.endNode].end * 10) / 10,
      });
      return false;
    });
    candidates = selectCriticCandidates(withoutTeasers, nodes, cfg);
    scannerTelemetry = {
      path: "full",
      ...scan.telemetry,
      rawCandidates: scan.candidates.length,
      mergedCandidates: merged.length,
      teaserRegion: region
        ? {
            endSec: Math.round(region.endSec * 10) / 10,
            hits: region.hits,
            firstHitStartSec: Math.round(region.firstHitStartSec * 10) / 10,
            lastHitEndSec: Math.round(region.lastHitEndSec * 10) / 10,
            originSpreadSec: Math.round(region.originSpreadSec),
          }
        : null,
      teaserDrops,
      criticCandidates: candidates.length,
      // The critic budget and what it left on the table. A candidate the strict
      // model never saw is an invisible loss - it looks exactly like a candidate
      // the critic rejected - and the two numbers that explain one are the
      // budget and the size of the pool it was applied to. `criticUnjudgedPool`
      // is deliberately the residual of BOTH rationing rules (the budget K and
      // the per-region diversity cap), because the point of publishing it is to
      // show that something was rationed, not which rule did it. A job record
      // with a large residual is the signal to raise CRITIC_MAX_CANDIDATES.
      criticBudgetK: criticBudget(nodes, cfg),
      criticUnjudgedPool: withoutTeasers.length - candidates.length,
      // Both of them, always, and never only one: these two numbers differ by
      // roughly 2x on a talking-head source (1649 vs 2768 on podcast-answer-arc)
      // and confusing them is what produced the budget defect above.
      // `speechSec` is the audio we can CUT on, `sourceSec` the audio that
      // carries speech at all.
      speechSec: Math.round(speechSec),
      sourceSec: Math.round(sourceSeconds(nodes)),
    };
  }

  // candidates must not span a transcript hole (spec §9) - a clip cut across
  // audio we never heard cannot be verified
  const missingRanges = transcription.missingRanges ?? [];
  let holeDrops = 0;
  if (missingRanges.length > 0) {
    const before = candidates.length;
    candidates = candidates.filter((c) => {
      const startSec = nodes[c.startNode].start;
      const endSec = nodes[c.endNode].end;
      return !missingRanges.some((r) => startSec < r.end && endSec > r.start);
    });
    holeDrops = before - candidates.length;
  }

  if (candidates.length === 0) {
    // Nothing left to judge AND the audio we lost is why: every moment the
    // scanner found straddled a transcript hole and was removed unheard. That
    // is the same unjudged emptiness the scanner and critic guards above catch,
    // so the same quota rule applies - a DONE 0-clip job burns the user's
    // minutes (usage sums every job that is not FAILED) while FAILED leaves the
    // quota untouched and BullMQ retries.
    if (holeDrops > 0) throw unheardAudioError(holeDrops, missingRanges);
    return {
      highlights: [],
      // No hole removed anything: the scanner looked at the audio we heard and
      // found nothing. That is a content answer, and the transcribe stage has
      // already ruled this coverage shippable (TRANSCRIPT_MIN_COVERAGE), so we
      // say so honestly rather than failing a job a retry could never change.
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry: { ...scannerTelemetry, keptVerdicts: 0, holeDrops },
      usage,
    };
  }

  const critic = await runCritic(client, usage, nodes, candidates, languageIso, cfg, {
    retryDelayMs: options.retryDelayMs,
  });

  // A critic that judged the candidates and rejected them returns REAL verdicts
  // with keep:false - that is a content outcome and falls through below. Zero
  // verdicts for a non-empty candidate set means nothing was judged at all: the
  // API answered but every row was empty/unknown/invalid, or every batch was
  // refused. Same quota rule as the scanner guard above: shipping DONE with 0
  // clips burns the user's minutes (usage sums every job that is not FAILED)
  // for output no model ever looked at, while FAILED leaves the quota untouched
  // and BullMQ retries. Never ship unjudged emptiness.
  //
  // One failure class for every reason, refusals included - see the zero-
  // survivor guard far below for why. The counts still travel in the message,
  // so a failed job stays diagnosable without the shape of the hole deciding
  // anything the user hears.
  if (critic.verdicts.length === 0) {
    const t = critic.telemetry;
    throw new AnalyzeTechnicalError(
      `critic produced 0 usable verdicts for ${candidates.length} candidates ` +
        `(omitted ${t.omittedDrops}, refused ${t.refusalDrops}, truncated ${t.truncatedDrops}, ` +
        `invariant ${t.invariantDrops}) - nothing was judged`
    );
  }

  // eligibility: keep + evidence gate + snap + copy language
  const eligible: SnappedClip[] = [];
  let evidenceDrops = 0;
  let evidenceWidened = 0;
  let snapDrops = 0;
  let copyRepairs = 0;
  let snippetFallbacks = 0;
  // Silent copy replacements, at both points where the code stops moving
  // boundaries. Like every other loss in this engine it has to leave a trace in
  // the job record: nobody reports the description they never saw, and this
  // fires precisely when something upstream already went wrong.
  const copyRegrounded: Array<{ id: string; at: "snap" | "shipped"; fields: string[] }> = [];
  /**
   * Ids whose TITLE is, right now, verbatim transcript speech the ENGINE wrote -
   * `snippetFallbackCopy` output, not a model's sentence. See the repair pass
   * after the finalizer for why this is tracked by provenance rather than by the
   * shape of the string.
   *
   * A set, not a flag on the clip, because membership is not monotonic: the
   * finalizer's title rewrite takes a clip back OUT of it, and that removal is
   * the whole reason the pass below costs one call on these fixtures instead of
   * two.
   */
  const snippetTitleIds = new Set<string>();
  /** Ids that have already spent their one repairCopy call, wherever it was
   *  spent. The bound is per CLIP and global, not per site. */
  const copyRepairAttempted = new Set<string>();
  const snippetTitleRepairs: Array<{
    id: string;
    from: string;
    to: string | null;
    outcome: "repaired" | "unusable" | "already_repaired";
  }> = [];
  const gateDropReasons: Record<string, number> = {};
  /**
   * Copy the critic grounded outside its own proposed range, by field. NOT a
   * drop - `regroundCopy` repairs it below - and deliberately a SEPARATE counter
   * from gateDropReasons, which means "this clip is gone" and must keep meaning
   * exactly that. Kept because it is a direct measure of critic-prompt drift: the
   * ca8dfec title rule took it from 2 to 9 across the eval suite in one commit.
   */
  const evidenceOutOfRange: Record<string, number> = {};
  const droppedVerdicts: Array<{ id: string; stage: string; reason: string; score: number }> = [];

  for (const verdict of critic.verdicts) {
    if (!verdict.keep) continue;

    // Evidence just past the chosen boundary is a boundary problem, not a
    // grounding failure: widen the range to contain its own evidence (snap
    // re-validates clean start, invariants and the 90s cap afterwards). Evidence
    // FURTHER out is a copy problem - the gate below reports it and regroundCopy
    // replaces the field - so between them nothing here can cost a clip.
    if (widenRangeToEvidence(verdict, nodes.length - 1)) evidenceWidened += 1;

    const gate = evidenceGate(verdict, nodes);
    if (!gate.ok) {
      evidenceDrops += 1;
      const reason = gate.reason ?? "unknown";
      gateDropReasons[reason] = (gateDropReasons[reason] ?? 0) + 1;
      droppedVerdicts.push({ id: verdict.id, stage: "gate", reason, score: verdict.score });
      continue;
    }
    for (const label of gate.outOfRange ?? []) {
      const key = `${label}_evidence_out_of_range`;
      evidenceOutOfRange[key] = (evidenceOutOfRange[key] ?? 0) + 1;
    }
    const snapped = snapNodes(verdict, nodes, cfg);
    if (!snapped.ok) {
      snapDrops += 1;
      droppedVerdicts.push({ id: verdict.id, stage: "snap", reason: snapped.reason, score: verdict.score });
      continue;
    }

    // The evidence gate above judged the critic's PROPOSED range; snap has just
    // moved the boundaries. Re-checking HERE, and not only after the finalizer,
    // is what lets the judge repair the damage: the finalizer is the one stage
    // that rewrites a title against the whole speech, so a clip whose copy this
    // pass reduces to a verbatim snippet still has a chance of a good one.
    const reground = regroundCopy(snapped.clip, nodes);
    if (reground.regrounded.length > 0) {
      copyRegrounded.push({ id: verdict.id, at: "snap", fields: reground.regrounded });
    }
    if (reground.regrounded.includes("title")) snippetTitleIds.add(verdict.id);
    const clip = reground.clip;

    // The clip's OWN speech - snap's range, not the critic's proposal, because
    // that is the text the viewer hears and the text the copy must match.
    const clipText = nodes
      .slice(clip.finalStartNode, clip.finalEndNode + 1)
      .filter((n) => n.hasWords)
      .map((n) => n.text)
      .join(" ");
    const copy = clip.verdict;
    if (scriptMismatch(`${copy.title} ${copy.description}`, clipText)) {
      copyRepairs += 1;
      copyRepairAttempted.add(verdict.id);
      const repaired = await repairCopy(client, usage, nodes, copy, languageIso, cfg, {
        retryDelayMs: options.retryDelayMs,
      });
      if (repaired && !scriptMismatch(`${repaired.title} ${repaired.description}`, clipText)) {
        copy.title = repaired.title;
        copy.description = repaired.description;
        snippetTitleIds.delete(verdict.id);
      } else {
        snippetFallbacks += 1;
        const snippet = snippetFallbackCopy(nodes, clip.finalStartNode, clip.finalEndNode);
        copy.title = snippet.title;
        copy.description = snippet.description;
        snippetTitleIds.add(verdict.id);
      }
    }
    eligible.push(clip);
  }

  // Selection hands FINALIZE more clips than the job ships. The finalizer is the
  // only component that sees the shipped set AS A SET - it dedups, trims and
  // vetoes - and every veto it lands would otherwise come straight out of the
  // user's clip count. The headroom absorbs them without a second LLM round
  // (spec §3, §9: backfilling from fresh candidates was rejected for that cost).
  const selection = selectAndOrder(eligible, cfg, cfg.softCap + cfg.finalizerHeadroom);
  // Ends move FORWARD here and nowhere else, and only for clips that will ship.
  // Before the finalizer on purpose: the finalizer is the stage that trims, and
  // it must get the last word on a boundary. Widening cannot invalidate copy -
  // evidence already inside the range stays inside a larger one - so this needs
  // no regroundCopy re-run, which is exactly why it is safe here and would not
  // be if it could shorten.
  const extension = await extendClipEnds(
    client,
    usage,
    selection.selected,
    nodes,
    cfg,
    { retryDelayMs: options.retryDelayMs }
  );
  // NEVER throws: any error, refusal, truncation or malformed output ships the
  // input set with a reason in telemetry. A stage with veto authority over
  // already-approved clips must not be able to turn a content answer into a
  // failed job - that would bill the user nothing but deny them a real reply
  // (billing invariant, engine-notes §6).
  const finalized = await finalizeClips(
    client,
    usage,
    extension.clips,
    nodes,
    languageIso,
    isoToLanguageName(languageIso),
    cfg,
    { retryDelayMs: options.retryDelayMs }
  );
  // A title the finalizer WROTE is a model's sentence again, so the clip leaves
  // the snippet-title set. This is the only thing that removes an id from it,
  // and it is why a snap-stage snippet title normally costs nothing below.
  for (const rewrite of finalized.telemetry.titleRewrites) {
    snippetTitleIds.delete(rewrite.id);
  }

  // The backstop for the OTHER thing that moves boundaries: the finalizer's
  // opening trim re-snaps a clip, and it may move the start arbitrarily far
  // forward. Same rule, applied where the boundaries finally stop.
  const shipped = finalized.clips.slice(0, cfg.softCap).map((clip) => {
    const result = regroundCopy(clip, nodes);
    if (result.regrounded.length > 0) {
      copyRegrounded.push({ id: clip.verdict.id, at: "shipped", fields: result.regrounded });
    }
    if (result.regrounded.includes("title")) snippetTitleIds.add(clip.verdict.id);
    return result.clip;
  });

  // ---------------------------------------------------------------------------
  // DEGENERATE TITLES - the last stage that can write copy, and the only one
  // that runs after every stage that can destroy it.
  // ---------------------------------------------------------------------------
  // podcast-answer-arc shipped a clip titled "Плюсы" - one word, "Pros" - at
  // score 0.66. The clip was fine: it passed the critic, the evidence gate and
  // the finalizer. The TITLE was not a model's bad sentence. It was node #316 of
  // the transcript, verbatim, installed by the `regroundCopy` call above after
  // the finalizer's trim moved the clip past the nodes its title cited.
  //
  // MEASURED, because the shape of the fix follows from which population the bad
  // title came from. Two populations, all four eval snapshots plus every title in
  // every critic verdict in both responses.json, gpt-5.6-luna and gpt-5.1
  // together - 150 titles, 102 distinct:
  //
  //   A. MODEL-AUTHORED titles (critic + finalizer). Word counts:
  //        3:1  4:3  5:9  6:17  7:28  8:21  9:10  10:9  11:2  13:1
  //      Shortest: "Человек ускоряет эволюцию" - 3 words, 25 chars. NOTHING at
  //      one or two words, in either model, kept or rejected. A length floor on
  //      model output would have fired ZERO times on this corpus: it is the
  //      inert knob engine-notes §4 warns about, and building it would have
  //      claimed to fix a defect while never once executing.
  //
  //   B. SNIPPET titles - `snippetFallbackCopy` takes one node's text verbatim,
  //      so its population is the transcript's clean-start nodes. 788 of them
  //      across the two fixtures, by word count:
  //        1:27  2:53  3:77  4:80  5:80  6:80  7:75  8:74  9:63  10:51  11+:128
  //      A smooth continuum straight down to one word ("Нет", "Михаил",
  //      "Плюсы"). Inside THIS population "Плюсы" is not an outlier at all -
  //      it is an ordinary member of the short end, and a length floor drawn
  //      inside it would be a cutoff through a continuum, which is the other
  //      half of the same warning.
  //
  // The gap is BETWEEN the two populations - min 3 words / 21 chars against a
  // floor of 1 word / 3 chars - not inside either. So the categorical unit of
  // decision is not LENGTH, it is PROVENANCE: authored, or verbatim. That is
  // what `snippetTitleIds` tracks, and it is why nothing here counts a character
  // or splits on whitespace.
  //
  // MULTILINGUAL BY CONSTRUCTION, and this is the second reason to prefer
  // provenance. A word-count or character-count rule has to answer what a word
  // is in Chinese, Japanese or Thai, where a whole title is one whitespace token
  // - it would flag every title in those languages while flagging none in
  // German, where one compound word can be a sentence. "This string came out of
  // snippetFallbackCopy" is the same true statement in all six supported locales
  // and in every script beyond them. The only length in the whole path is
  // `truncateTitle`'s pre-existing 70-CODE-POINT cap, which is already
  // surrogate-safe.
  //
  // REPAIR, NEVER DROP. The clip cleared every content gate; the copy is broken
  // because our own code moved a boundary. Dropping it would spend a real clip to
  // avoid a bad line of text, and engine-notes §4's rule about staying quiet and
  // retrying points the same way. So: one repair attempt, and if it does not
  // produce something usable the snippet title SHIPS. That is the lesser harm in
  // both directions - the snippet is grounded and in the clip's own language by
  // construction, so the worst case is a dull title on a good clip, against a
  // user who paid for a clip and got nothing.
  //
  // BOUNDED STRUCTURALLY, like the critic's omission retry: this is one pass over
  // a fixed array with no recursion and no loop, and `copyRepairAttempted` is
  // global per clip, so a clip whose language repair already failed upstream does
  // not get a second call here. There is no counter to get wrong.
  for (let i = 0; i < shipped.length; i++) {
    const clip = shipped[i];
    const id = clip.verdict.id;
    if (!snippetTitleIds.has(id)) continue;
    const from = clip.verdict.title;

    if (copyRepairAttempted.has(id)) {
      snippetTitleRepairs.push({ id, from, to: null, outcome: "already_repaired" });
      continue;
    }
    copyRepairAttempted.add(id);

    const clipText = nodes
      .slice(clip.finalStartNode, clip.finalEndNode + 1)
      .filter((n) => n.hasWords)
      .map((n) => n.text)
      .join(" ");
    const repaired = await repairCopy(client, usage, nodes, clip.verdict, languageIso, cfg, {
      retryDelayMs: options.retryDelayMs,
    });
    // Same acceptance test the language-repair path uses, plus "it actually
    // changed something": a repair that hands back the snippet repaired nothing
    // and must not be reported as a fix.
    const usable =
      repaired !== null &&
      repaired.title !== from &&
      !scriptMismatch(repaired.title, clipText);
    if (!usable) {
      snippetTitleRepairs.push({ id, from, to: null, outcome: "unusable" });
      continue;
    }
    // TITLE ONLY. The description is a verbatim snippet too, and dull, but it is
    // not the hook and it is not what broke; swapping it as well would widen the
    // blast radius of a call whose only acceptance test is a script check.
    // titleEvidenceNodes stays as regroundCopy set it - the clip's own first
    // speech node, inside the shipped range - which remains a true in-range
    // citation for a title the model wrote from that same clip's text.
    shipped[i] = { ...clip, verdict: { ...clip.verdict, title: repaired.title } };
    snippetTitleIds.delete(id);
    snippetTitleRepairs.push({ id, from, to: repaired.title, outcome: "repaired" });
  }

  const snippetTitlesRepaired = snippetTitleRepairs.filter(
    (r) => r.outcome === "repaired"
  ).length;

  const highlights = shipped.map(toHighlight);

  const telemetry = {
    ...scannerTelemetry,
    criticVerdicts: critic.verdicts.length,
    verdictScores: critic.verdicts
      .map((v) => ({ id: v.id, keep: v.keep, score: v.score }))
      .sort((a, b) => b.score - a.score),
    ...critic.telemetry,
    evidenceDrops,
    evidenceWidened,
    gateDropReasons,
    evidenceOutOfRange,
    droppedVerdicts,
    snapDrops,
    copyRepairs,
    snippetFallbacks,
    copyRegrounded,
    // Shipped clips whose title was engine-written verbatim speech with nothing
    // left downstream to rewrite it, and what the one repair call did about it.
    // flagged = repaired + kept, always: the three are computed from one array.
    snippetTitlesFlagged: snippetTitleRepairs.length,
    snippetTitlesRepaired,
    snippetTitlesKept: snippetTitleRepairs.length - snippetTitlesRepaired,
    snippetTitleRepairs,
    tier: selection.tier,
    droppedByNms: selection.droppedByNms,
    // THE WHOLE OBJECT, never a hand-picked subset of its counters. `skipped` is
    // the only field that separates "the stage never ran" from "it ran and
    // declined every clip" - both are zeros everywhere else - and `refusedBy` is
    // the only thing that says WHICH prompt edit a rising `refused` argues for.
    // This engine has already shipped one defect from two facts sharing one
    // field: `lowQuality` meant "a degraded model judged this" while the bot
    // printed "no strong moments found" from it, so a user got 12 good clips
    // each headed by a false apology (job cmscht6rp001xq41s5rhjx6q0).
    endExtension: extension.telemetry,
    // The three numbers that make the finalizer's arithmetic readable in a job
    // record: what it was given, what it returned, what the soft cap then cut.
    // Without them a clip lost to the cap looks identical to a clip the judge
    // vetoed, and this stage's failure mode is an invisible loss.
    //
    // Counted off the ARGUMENT the finalizer received, not off selection. The
    // two agree today only because the extension stage returns its input 1:1 on
    // every path, and nothing at this call site says so - a counter that reads
    // "what it was given" has to read what was given.
    selectedForFinalizer: extension.clips.length,
    finalizerSurvivors: finalized.clips.length,
    ...finalized.telemetry,
    kept: highlights.length,
    meanLexicalOverlap: mean(
      shipped.map((c) =>
        lexicalOverlap(
          c.verdict.title,
          nodes.slice(c.finalStartNode, c.finalEndNode + 1).map((n) => n.text).join(" ")
        )
      )
    ),
    durations: highlights.map((h) => Math.round((h.end - h.start) * 10) / 10),
  };

  if (highlights.length === 0) {
    // Zero clips is only an ANSWER if every candidate actually got answered.
    // The critic's contract is one verdict per candidate id - it has keep:false
    // for "not worth clipping", so a candidate that comes back with no verdict
    // at all was not judged, it was skipped. With survivors that is mere recall
    // loss and we ship what we have; with nothing left it becomes the whole
    // answer, and "no viable moments" would assert something about moments no
    // model ever looked at.
    // Same quota rule as the guards above: DONE with 0 clips burns the user's
    // minutes (usage sums every job that is not FAILED) while FAILED leaves the
    // quota untouched and BullMQ retries - and unlike a cached transcript, a
    // re-run genuinely re-rolls the critic, so the retry can heal this.
    //
    // Deliberately measured as candidates-without-a-verdict, NOT as gate/snap
    // drops: a clip that cannot be snapped to clean boundaries or whose copy is
    // not grounded WAS judged, and our own quality bar rejecting it is the
    // engine working as designed (spec §7-§8). Those keep shipping content
    // reasons. Hole-dropped candidates are excluded too - `candidates` is
    // already post-hole - because a re-run reads the same cached transcript and
    // 4c3fc05 settled that case as content.
    //
    // The sum below is exactly "candidates that never produced a real verdict",
    // and the three terms are the three, mutually exclusive, ways that happens
    // (critic.ts):
    //   - truncatedDrops: dropTruncated() gave up on a batch and put its ids in
    //     accountedDropIds.
    //   - refusalDrops:   dropRefused() did the same.
    //   - omittedDrops:   every remaining candidate with no verdict, computed as
    //     `candidates - verdictIds - accountedDropIds`. Because it subtracts
    //     accountedDropIds it can never re-count the first two, and because it
    //     subtracts verdict IDS (not rows) it DOES already include a candidate
    //     whose only row died in the invariant filter.
    // No candidate lands in two of them: accountedDropIds is filled only by the
    // two terminal drop paths, each of which returns immediately, and the
    // per-batch id guard stops another batch's row from ever answering for a
    // dropped id.
    //
    // invariantDrops is deliberately NOT added. It counts ROWS, not candidates:
    // a hallucinated foreign id belongs to no candidate at all, and a duplicate
    // row belongs to a candidate that already has its verdict. Adding it would
    // invent unjudged candidates that do not exist. (The comment 2bb036b left
    // here claimed malformed rows were the difference between this sum and
    // `candidates.length - verdicts.length`. They are not - a candidate whose
    // row was malformed is counted by both, since it has no verdict id.)
    //
    // Why not `candidates.length - verdicts.length`, which today yields the same
    // number: it only does so as long as candidate ids stay unique and every
    // verdict maps back to an input candidate. It measures the population by
    // accident rather than by name, and it cannot say WHY anything went
    // unjudged, so the error message below could not either. The sum reconciles
    // against telemetry the critic already publishes and each term has its own
    // test.
    //
    // Truncated and refused candidates ARE counted, reversing 2bb036b. Both
    // reasons were "content-shaped anomaly of the candidate, reproduces on a
    // re-run, so failing burns three BullMQ attempts for nothing":
    //   - Truncation does not reliably reproduce. critic.ts's own measurement
    //     note records per-call variance the same order as the budget headroom
    //     (a live run measured 2184 completion tokens at 6/6000, below the 2857
    //     seen at 6/5000), so a candidate that truncates at the margin can
    //     complete on the next roll. a4590ce made this rare, not impossible.
    //   - A refusal may well be the model reacting to the material rather than a
    //     fault, and it may indeed repeat. It is still not a judgement: the
    //     critic said nothing about whether that moment is worth clipping, so
    //     "no viable moments" cannot speak for it. The choice is between a
    //     wasted retry ending in FAILED (free to the user) and billing them for
    //     a claim about material we declined to read.
    // The asymmetry decides it: over-failing costs three cheap retries and a
    // diagnosable error; under-failing takes the user's minutes for an answer
    // that was never obtained. Note the guard needs zero survivors AND a missing
    // candidate, so a video whose moments really were judged still ships its
    // honest "no".
    //
    // ONE error class for all three reasons, and no promotion of any subset to
    // an unrecoverable failure. 6434d4d tried the opposite - refusals being the
    // whole unjudged population raised a distinct error that cancelled the
    // remaining BullMQ attempts - and it was wrong in both directions:
    //   - The predicate was `unjudged === refusalDrops`, i.e. "refusals are the
    //     whole UNJUDGED population", not the whole population. 39 candidates
    //     judged keep:false and 1 refused satisfied it, and the user was told we
    //     could not read their video when 39/40 of it had been read and found
    //     weak - with no attempts left to prove otherwise.
    //   - refusalDrops does not even mean "the model refused this material
    //     twice". critic.ts's catch-all also lands there when the primary model
    //     died with a hard error and the FALLBACK model refused once (see the
    //     note on dropRefused) - an upstream outage, permanently condemning a
    //     good video.
    // Both are the same mistake: asserting something about the cause from a
    // counter that does not carry it. So we assert nothing. Every unjudged
    // population fails the same way, keeps all three attempts, and bills the
    // user nothing - three retries of a cheap failure cost far less than one
    // wrong claim that someone's video is unusable, and the retry can genuinely
    // rescue a refusal too, because the scanner is itself a model call and the
    // next attempt does not present the same candidate windows.
    const t = critic.telemetry;
    const unjudged = t.omittedDrops + t.truncatedDrops + t.refusalDrops;
    if (unjudged > 0) {
      throw new AnalyzeTechnicalError(
        `no clip survived and ${unjudged} of ${candidates.length} candidate(s) never got a verdict ` +
          `(omitted ${t.omittedDrops}, refused ${t.refusalDrops}, truncated ${t.truncatedDrops}, ` +
          `invariant ${t.invariantDrops}) - the empty result is not a complete answer`
      );
    }

    // Every candidate survived the holes, every one came back with a real
    // verdict, and the emptiness is therefore a judgement - keep:false, or our
    // own evidence/snap/selection bar - made on audio we really heard. Never
    // technical: PARTIAL_TRANSCRIPT tells the user both halves (we lost some
    // audio, and the rest held no strong moments).
    return {
      highlights: [],
      noClipsReason: partial ? "PARTIAL_TRANSCRIPT" : "NO_VIABLE_MOMENTS",
      telemetry,
      usage,
    };
  }

  return { highlights, telemetry, usage };
}

/** Every candidate the scanner found was thrown away for crossing a transcript
 *  hole, so nothing was ever judged and the audio we lost is the reason. That
 *  is the branch's established technical shape ("nothing was judged"), not a
 *  verdict about the video - the same rule the scanner and critic guards apply.
 *
 *  Deliberately NOT triggered by mere partialness. A partial transcript whose
 *  surviving candidates the critic actually judged and rejected is a content
 *  answer about audio we really heard: the transcribe stage has already ruled
 *  that coverage >= TRANSCRIPT_MIN_COVERAGE is good enough to ship clips from,
 *  and PARTIAL_TRANSCRIPT is the user-facing copy for exactly that outcome.
 *  Failing it instead would burn three attempts on a cached transcript that
 *  cannot change and replace translated copy with this engineer prose. */
function unheardAudioError(
  holeDrops: number,
  missingRanges: Array<{ start: number; end: number }>
): AnalyzeTechnicalError {
  const lostSec = Math.round(
    missingRanges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0)
  );
  return new AnalyzeTechnicalError(
    `all ${holeDrops} candidate(s) crossed audio we never heard ` +
      `(${missingRanges.length} missing range(s), ~${lostSec}s lost) - nothing was judged`
  );
}

function toHighlight(clip: SnappedClip): V2Highlight {
  const v = clip.verdict;
  return {
    start: clip.startSec,
    end: clip.endSec,
    hookStart: clip.hookStartSec,
    hookEnd: clip.hookEndSec,
    payoffAt: clip.payoffSec,
    title: v.title,
    description: v.description,
    score: v.score,
    language: v.language,
    lowQuality: v.lowQuality ?? false,
    shortMoment: clip.shortMoment,
    kind: v.kind,
    // The range that SHIPPED, not the critic's proposal - these are diagnostics,
    // and a diagnostic that names nodes the clip does not contain sent a real
    // investigation (job cms2c8ahm) looking in the wrong place.
    _startNode: clip.finalStartNode,
    _endNode: clip.finalEndNode,
    _titleEvidenceNodes: v.titleEvidenceNodes,
    _descriptionEvidenceNodes: v.descriptionEvidenceNodes,
    _grounded: v.grounded,
    _boundaryConfidence: clip.boundaryConfidence,
  };
}

/** Evidence cited at most EVIDENCE_BOUNDARY_SLACK_NODES outside [startNode,
 *  endNode] pulls the boundary out to contain it. Mutates the verdict; returns
 *  whether anything moved. Evidence further out stays a genuine grounding
 *  failure - and the same slack governs the mirror question after the
 *  boundaries stop moving (gates.ts, regroundCopy). */
function widenRangeToEvidence(
  verdict: { startNode: number; endNode: number; titleEvidenceNodes: number[]; descriptionEvidenceNodes: number[] },
  maxIdx: number
): boolean {
  const evidence = [...verdict.titleEvidenceNodes, ...verdict.descriptionEvidenceNodes]
    .filter((i) => Number.isInteger(i) && i >= 0 && i <= maxIdx);
  if (evidence.length === 0) return false;
  const min = Math.min(...evidence);
  const max = Math.max(...evidence);
  let widened = false;
  if (min < verdict.startNode && verdict.startNode - min <= EVIDENCE_BOUNDARY_SLACK_NODES) {
    verdict.startNode = min;
    widened = true;
  }
  if (max > verdict.endNode && max - verdict.endNode <= EVIDENCE_BOUNDARY_SLACK_NODES) {
    verdict.endNode = max;
    widened = true;
  }
  return widened;
}

/** Coarse last-resort language guess for legacy transcripts without a language.
 *  New V2 transcripts carry the Whisper-detected ISO code and never hit this. */
function scriptFallbackIso(text: string): string {
  const sample = text.slice(0, 2000);
  switch (dominantScript(sample)) {
    case "cyrillic":
      return "ru";
    case "arabic":
      return "ar";
    case "cjk":
      return "zh";
    default:
      return "en";
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}
