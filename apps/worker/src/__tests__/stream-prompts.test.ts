import { describe, expect, it } from "vitest";
import {
  CRITIC_PROMPT_TEMPLATE,
  CRITIC_PROMPT_TEMPLATE_STREAM,
  criticSystemPrompt,
  SCANNER_PROMPT,
  scannerSystemPrompt,
} from "../analyze-v2/prompts";

/**
 * Task T2 of spec 2026-08-19-stream-analyze-mode (S2 + S5). These tests pin:
 *  - standard mode (default, and the explicit "standard" literal) is
 *    byte-identical to the pre-T2 critic and scanner prompts;
 *  - stream mode carries the three measured critic deltas (§S2) and the
 *    scanner nudge (§S5), without touching the shared JSON contract, the
 *    node/¶ boundary mechanics, or the language placeholders.
 */

/** The JSON-contract tail: "For EACH candidate return..." through the final
 *  "Output ONLY..." line - rules 1-8, the echo instruction, everything the
 *  critic must obey once it has judged a candidate. Both templates must
 *  render this IDENTICALLY (same language args) - that is the "SAME JSON
 *  contract" half of the spec's "start from the existing one" instruction. */
function jsonContractSection(prompt: string): string {
  const marker = "For EACH candidate return,";
  const idx = prompt.indexOf(marker);
  if (idx < 0) throw new Error("no JSON-contract marker in this prompt");
  return prompt.slice(idx);
}

/** The header + node/¶ boundary mechanics paragraph, before either template's
 *  scoring section begins. Must also render IDENTICALLY between the two
 *  templates - "SAME node/¶ boundary mechanics" per the spec. */
function headerMechanics(prompt: string): string {
  const marker = "\nScore each candidate 0.0-1.0 for SCROLL-STOPPING potential";
  const idx = prompt.indexOf(marker);
  if (idx < 0) throw new Error("no SCROLL-STOPPING marker in this prompt");
  return prompt.slice(0, idx);
}

describe("criticSystemPrompt - mode (T2 §S2)", () => {
  it("default (no mode arg) is byte-identical to the untouched CRITIC_PROMPT_TEMPLATE", () => {
    const expected = CRITIC_PROMPT_TEMPLATE.replaceAll("{{LANGUAGE_NAME}}", "English").replaceAll(
      "{{LANGUAGE_ISO}}",
      "en"
    );
    expect(criticSystemPrompt("en", "English")).toBe(expected);
  });

  it('explicit "standard" mode is byte-identical to the default', () => {
    expect(criticSystemPrompt("en", "English", "standard")).toBe(
      criticSystemPrompt("en", "English")
    );
  });

  it("standard mode keeps the doubly-strict short-clip guard and carries no stream-rubric phrase", () => {
    const standard = criticSystemPrompt("en", "English");
    expect(standard).toMatch(/Be doubly strict with short clips/);
    expect(standard).not.toContain("PRIME MATERIAL");
    expect(standard).not.toContain("IDEAL STREAM CLIP");
  });

  it('stream mode is byte-identical to CRITIC_PROMPT_TEMPLATE_STREAM with placeholders substituted', () => {
    const expected = CRITIC_PROMPT_TEMPLATE_STREAM.replaceAll(
      "{{LANGUAGE_NAME}}",
      "English"
    ).replaceAll("{{LANGUAGE_ISO}}", "en");
    expect(criticSystemPrompt("en", "English", "stream")).toBe(expected);
  });

  it("stream mode drops the doubly-strict clause and states the trigger-inside rubric instead", () => {
    const stream = criticSystemPrompt("en", "English", "stream");
    expect(stream).not.toMatch(/doubly strict/i);
    // the replacement clause: an 8-20s reaction with its trigger inside is the
    // ideal shape, and only a trigger-less burst is rejected
    expect(stream).toMatch(/8-20s reaction WITH its trigger inside/);
    expect(stream).toMatch(/IDEAL STREAM CLIP/);
    expect(stream).toMatch(/Reject only a\s+burst whose trigger is NOWHERE inside the window/);
  });

  it("stream mode declares reaction bursts PRIME material and instructs moving start_node earlier to include the trigger", () => {
    const stream = criticSystemPrompt("en", "English", "stream");
    expect(stream).toMatch(/REACTION BURSTS ARE PRIME MATERIAL/);
    // scream / rage break / absurd exchange / roast / instant-karma beat /
    // victory gloat - the spec's own list of burst types
    expect(stream).toMatch(/scream, a rage\s+break, an absurd exchange, a roast, an instant-karma beat, or a victory gloat/);
    expect(stream).toMatch(/move start_node EARLIER/);
  });

  it("stream mode anchors scoring on emotional amplitude, quotability and meme potential, not story completeness", () => {
    const stream = criticSystemPrompt("en", "English", "stream");
    expect(stream).toMatch(/EMOTIONAL AMPLITUDE, QUOTABILITY, and MEME\s+POTENTIAL/);
    expect(stream).toMatch(/not story completeness/);
    // self-containment reframed as trigger + reaction, not setup + story
    expect(stream).toMatch(/SELF-CONTAINED as TRIGGER \+ REACTION, not as setup \+ story/);
    // "reject bait" (the hook-payoff bullet) is kept verbatim
    expect(stream).toContain("Does it deliver on its own hook? (No bait it does not pay off.)");
  });

  it("keeps the COLD VIEWER RULE for narrative clips - same heading, same two-option repair, same demonstrative example", () => {
    const standard = criticSystemPrompt("en", "English");
    const stream = criticSystemPrompt("en", "English", "stream");
    for (const prompt of [standard, stream]) {
      expect(prompt).toMatch(/COLD VIEWER RULE - the most common failure, check it FIRST/);
      expect(prompt).toMatch(/1\. Move start_node EARLIER/);
      expect(prompt).toMatch(/я считаю ЭТОТ КОНТЕНТ экстремистским/);
    }
  });

  it("shares byte-identical header and node/¶ boundary mechanics between modes", () => {
    const standard = criticSystemPrompt("en", "English");
    const stream = criticSystemPrompt("en", "English", "stream");
    expect(headerMechanics(stream)).toBe(headerMechanics(standard));
  });

  it("shares a byte-identical JSON contract (rules 1-8, echo, output line) between modes", () => {
    const standard = criticSystemPrompt("ru", "Russian");
    const stream = criticSystemPrompt("ru", "Russian", "stream");
    expect(jsonContractSection(stream)).toBe(jsonContractSection(standard));
  });

  it("substitutes the clip's language in both modes and leaves no placeholder behind", () => {
    for (const mode of ["standard", "stream"] as const) {
      const en = criticSystemPrompt("en", "English", mode);
      expect(en).toContain("(English, en)");
      expect(en).not.toContain("{{");
      const ru = criticSystemPrompt("ru", "Russian", mode);
      expect(ru).not.toContain("English");
      expect(ru).not.toContain("{{");
    }
  });
});

describe("scannerSystemPrompt - mode (T2 §S5)", () => {
  it("default (no mode arg) is byte-identical to SCANNER_PROMPT", () => {
    expect(scannerSystemPrompt()).toBe(SCANNER_PROMPT);
  });

  it('explicit "standard" mode is byte-identical to SCANNER_PROMPT and carries no stream nudge', () => {
    expect(scannerSystemPrompt("standard")).toBe(SCANNER_PROMPT);
    expect(scannerSystemPrompt("standard")).not.toContain("reaction bursts as first-class candidates");
  });

  it("stream mode injects the nudge paragraph exactly once, between the bullet list and the SETUP paragraph", () => {
    const prompt = scannerSystemPrompt("stream");
    const marker = "treat reaction bursts as first-class candidates";
    const occurrences = prompt.split(marker).length - 1;
    expect(occurrences).toBe(1);

    const bulletEnd = prompt.indexOf(
      "a curiosity hook: an unfinished thought that makes you want the answer"
    );
    const nudgeIdx = prompt.indexOf(marker);
    const setupIdx = prompt.indexOf("Include the SETUP in the range:");
    expect(bulletEnd).toBeGreaterThan(-1);
    expect(nudgeIdx).toBeGreaterThan(bulletEnd);
    expect(setupIdx).toBeGreaterThan(nudgeIdx);
  });

  it("stream mode names reaction bursts, rage, screams, banter, roasts and instant-karma beats as first-class candidates without a narrative arc", () => {
    const prompt = scannerSystemPrompt("stream");
    expect(prompt).toMatch(/a scream, a rage break, a banter exchange, a roast, or an\s+instant-karma beat/);
    expect(prompt).toMatch(/even without a\s+narrative arc/);
    expect(prompt).toMatch(/1-3 short lines of raw,\s+high-emotion speech/);
    expect(prompt).toMatch(/Flag these with a HIGH interest score/);
  });

  it("stream mode still contains the unmodified standard head and tail", () => {
    const prompt = scannerSystemPrompt("stream");
    expect(prompt).toContain(
      'You are a fast recall scanner for a short-form video clipping tool'
    );
    expect(prompt).toContain("Output ONLY the JSON object described by the schema.");
    expect(prompt).toContain("Return at most 12 moments per slice");
  });
});
