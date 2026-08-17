import { describe, expect, it } from "vitest";
import { ARC_AUDIT_SYSTEM, arcAuditClipBlock, arcAuditUserPrompt } from "../analyze-v2/prompts";
import type { CriticVerdict, SentenceNode, SnappedClip } from "../analyze-v2/types";

/** 45 unique, individually-addressable nodes so a leaked line is unmistakable -
 *  "Unique node 7." cannot be confused with any other node's text. Node 30 is
 *  deliberately mid-flow (weak leading boundary + lowercase onset) so the ¶
 *  marker has something real to distinguish. */
function nodes(count = 45): SentenceNode[] {
  const out: SentenceNode[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      index: i,
      start: i * 3,
      end: i * 3 + 2.5,
      text: `Unique node ${i}.`,
      hasWords: true,
      trailingStrength: 1,
      leadingStrength: 1,
    });
  }
  out[30] = { ...out[30], leadingStrength: 0.3, text: "unique node 30, mid-flow." };
  return out;
}

function clip(
  n: SentenceNode[],
  id: string,
  startNode: number,
  endNode: number
): SnappedClip {
  const verdict: CriticVerdict = {
    id,
    keep: true,
    score: 0.8,
    grounded: true,
    selfContained: true,
    startNode,
    payoffNode: endNode,
    endNode,
    hookStartNode: startNode,
    hookEndNode: endNode,
    title: `title ${id}`,
    description: `description ${id}`,
    titleEvidenceNodes: [startNode],
    descriptionEvidenceNodes: [startNode],
    language: "en",
  };
  return {
    verdict,
    startSec: n[startNode].start,
    endSec: n[endNode].end,
    finalStartNode: startNode,
    finalEndNode: endNode,
    hookStartSec: n[startNode].start,
    hookEndSec: n[endNode].end,
    payoffSec: n[endNode].end,
    shortMoment: false,
  };
}

/** Splits a rendered block into its three labeled sections, so an assertion
 *  can say "node 19's text appears in CONTEXT BEFORE" rather than merely
 *  "somewhere in this string" - the property that actually matters is WHICH
 *  section a line landed in. */
function sections(block: string): { viewer: string; before: string; after: string } {
  const viewerAt = block.indexOf("THE VIEWER SEES");
  const beforeAt = block.indexOf("CONTEXT BEFORE");
  const afterAt = block.indexOf("CONTEXT AFTER");
  return {
    viewer: block.slice(viewerAt, beforeAt),
    before: block.slice(beforeAt, afterAt),
    after: block.slice(afterAt),
  };
}

describe("arcAuditClipBlock", () => {
  it("renders the header with id, duration and the node range", () => {
    const n = nodes();
    const c = clip(n, "c7", 20, 23);
    const expectedSec = Math.round(c.endSec - c.startSec);
    // n[20].start = 60, n[23].end = 71.5 -> duration 11.5 -> rounds to 12
    expect(expectedSec).toBe(12);
    const block = arcAuditClipBlock(c, n);
    expect(block.split("\n")[0]).toBe(`CLIP c7 | ${expectedSec}s | nodes #20..#23`);
  });

  it("THE VIEWER SEES renders exactly [finalStartNode, finalEndNode], nothing more, nothing less", () => {
    const n = nodes();
    const block = arcAuditClipBlock(clip(n, "c0", 20, 23), n);
    const { viewer } = sections(block);
    for (let i = 20; i <= 23; i++) {
      expect(viewer, `node #${i} missing from THE VIEWER SEES`).toContain(`#${i} [`);
      expect(viewer).toContain(n[i].text);
    }
    for (const outside of [19, 24]) {
      expect(viewer, `node #${outside} leaked into THE VIEWER SEES`).not.toContain(`#${outside} [`);
    }
  });

  it("THE VIEWER SEES prints one timestamp per line, finalizer-style, not a range", () => {
    const n = nodes();
    const block = arcAuditClipBlock(clip(n, "c0", 20, 23), n);
    const { viewer } = sections(block);
    const line20 = viewer.split("\n").find((l) => l.includes("#20 ["))!;
    expect(line20).toContain(`[${n[20].start.toFixed(1)}s]`);
    expect(line20).not.toContain("-"); // no "Xs-Ys" range on this side
  });

  it("CONTEXT BEFORE renders up to CONTEXT_BEFORE (16) nodes before the clip's own start, critic-style", () => {
    const n = nodes();
    const block = arcAuditClipBlock(clip(n, "c0", 20, 23), n);
    const { before } = sections(block);
    for (let i = 4; i <= 19; i++) {
      expect(before, `node #${i} missing from CONTEXT BEFORE`).toContain(`#${i} [`);
    }
    // exactly 16 nodes: #3 is one too far back
    expect(before).not.toContain("#3 [");
    // the clip's own first node must not appear in CONTEXT BEFORE
    expect(before).not.toContain("#20 [");
    // seconds RANGE on this side, unlike THE VIEWER SEES
    const line19 = before.split("\n").find((l) => l.includes("#19 ["))!;
    expect(line19).toContain(`[${n[19].start.toFixed(1)}s-${n[19].end.toFixed(1)}s]`);
  });

  it("CONTEXT AFTER renders up to CONTEXT_AFTER (20) nodes after the clip's own end, critic-style", () => {
    const n = nodes();
    const block = arcAuditClipBlock(clip(n, "c0", 20, 23), n);
    const { after } = sections(block);
    for (let i = 24; i <= 43; i++) {
      expect(after, `node #${i} missing from CONTEXT AFTER`).toContain(`#${i} [`);
    }
    // exactly 20 nodes: #44 is one too far forward
    expect(after).not.toContain("#44 [");
    expect(after).not.toContain("#23 [");
  });

  it("marks a clean start with ¶ and leaves a mid-flow node unmarked", () => {
    const n = nodes();
    // clip spans the mid-flow node so it shows up in THE VIEWER SEES
    const block = arcAuditClipBlock(clip(n, "c0", 28, 32), n);
    const line = (i: number) => block.split("\n").find((l) => l.includes(`#${i} [`))!;
    expect(line(29).startsWith("¶ ")).toBe(true);
    expect(line(30).startsWith("¶ ")).toBe(false);
    expect(line(31).startsWith("¶ ")).toBe(true);
  });

  it("names an empty CONTEXT BEFORE at the start of the transcript instead of rendering nothing", () => {
    const n = nodes();
    const block = arcAuditClipBlock(clip(n, "c0", 0, 3), n);
    const { before } = sections(block);
    expect(before).toContain("clip starts at the beginning of the transcript");
    expect(before).not.toMatch(/#\d+ \[/);
  });

  it("names an empty CONTEXT AFTER at the end of the transcript instead of rendering nothing", () => {
    const n = nodes();
    const last = n.length - 1;
    const block = arcAuditClipBlock(clip(n, "c0", last - 2, last), n);
    const { after } = sections(block);
    expect(after).toContain("clip ends at the end of the transcript");
    expect(after).not.toMatch(/#\d+ \[/);
  });

  it("truncates the before-window near the start rather than reading negative indices", () => {
    const n = nodes();
    const block = arcAuditClipBlock(clip(n, "c0", 5, 7), n);
    const { before } = sections(block);
    for (let i = 0; i <= 4; i++) expect(before).toContain(`#${i} [`);
    expect(before).not.toContain("clip starts at the beginning"); // some real context exists
  });
});

describe("arcAuditUserPrompt", () => {
  it("joins clip blocks with the engine's standard separator", () => {
    const n = nodes();
    const user = arcAuditUserPrompt([clip(n, "c1", 0, 2), clip(n, "c2", 10, 12)], n);
    expect(user.split("\n\n---\n\n")).toHaveLength(2);
    expect(user).toContain("CLIP c1");
    expect(user).toContain("CLIP c2");
  });
});

// ---------------------------------------------------------------------------
// meta_opening: recap-narration examples (spec 2026-08-10 task 9). Two shapes
// recurred on non-Russian sources and were caught by neither audit nor
// finalizer rule 7 - "Cerita dimulai dengan memperlihatkan..." (id, a recap
// that narrates itself) and "In this video you saw us..." (en, an outro that
// recaps) - plus a composed ar shape of the same kind. This block only checks
// the examples render and that a distant, unrelated rule did not move.
// ---------------------------------------------------------------------------

describe("ARC_AUDIT_SYSTEM - recap-narration meta_opening examples (spec 2026-08-10 task 9)", () => {
  it("renders the id, en and ar recap-narration examples under meta_opening", () => {
    expect(ARC_AUDIT_SYSTEM).toContain("Cerita dimulai dengan memperlihatkan...");
    expect(ARC_AUDIT_SYSTEM).toContain("In this video you saw us...");
    expect(ARC_AUDIT_SYSTEM).toContain("في هذا الفيديو شفنا...");
  });

  it("leaves a distant, unrelated rule (EXIT's mid_thought bullet) byte-identical", () => {
    expect(ARC_AUDIT_SYSTEM).toContain(
      "   - mid_thought: the sentence itself is left open, mid-clause or mid-list."
    );
  });
});
