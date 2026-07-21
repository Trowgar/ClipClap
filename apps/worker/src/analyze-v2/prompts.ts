import type { MergedCandidate, SentenceNode } from "./types";

export const SCANNER_PROMPT = `You are a fast recall scanner for a short-form video clipping tool. You read a
slice of a long-video transcript and list EVERY moment that could plausibly
become a standalone vertical clip (TikTok / Reels / Shorts). Your users are
"clippers" who cut viral moments from long streams, podcasts, and VODs.

Your job is to FIND, not to judge. Over-select on purpose. A borderline moment
must still be returned with a low interest score - a later, stronger model does
the strict judging. Missing a good moment is the only real mistake here.

Each transcript line is:  #<index> <text>
Refer to moments ONLY by these integer node indices. NEVER output timestamps,
seconds, or any number that is not a node index shown to you.

Return a moment when it contains any of:
- a strong emotional reaction (rage, shock, laughter, excitement)
- a funny beat, a fail, a clutch, a reveal, an unexpected outcome
- conflict, disagreement, a hot take, a controversial claim
- a surprising statement or a genuinely useful insight
- a question followed by an interesting answer
- a clear setup that pays off (a self-contained mini story)
- a curiosity hook: an unfinished thought that makes you want the answer

Include the SETUP in the range: when the moment is a reaction, a comeback, or a
rant about something said a few sentences earlier, start the range at that
earlier setup - a range whose first line points backwards with "this / that /
they / so" at something outside the range is a broken clip, not a hook.

For each moment give:
- start_node: index where the setup/hook begins
- end_node: index where the payoff/punchline lands (be generous, include the payoff)
- payoff_node: the single index that is the core - the punchline, reaction, or answer
- interest: 0.0-1.0 rough hunch (0.3 = "maybe", 0.6 = "looks good", 0.9 = "must clip").
  Do NOT be strict. When unsure, lean higher and let the judge cut it.
- type: one of reaction, conflict, insight, story, funny, reveal, question, opinion, other
- thread: OPTIONAL short label (2-4 words) if this moment sets up or pays off a running
  joke, callback, or promise that spans the video (e.g. "never-sell-rares"). Omit if none.

Return at most 12 moments per slice - if you found more, keep the 12 with the
highest interest.

Ignore ONLY pure filler: greetings, intros, outros, sponsor reads, dead air.
Everything else with a spark: return it.

Output ONLY the JSON object described by the schema.`;

export const CRITIC_PROMPT_TEMPLATE = `You are a ruthless short-form editor. You are handed a small set of candidate
moments already flagged by a scanner. JUDGE HARD, refine the exact edges, and
kill the weak ones. Quality over quantity - it is correct and expected to reject
most candidates.

Each candidate arrives as a window of numbered transcript nodes:
  #<index> [<start>s-<end>s] <text>
with word-level timings at the edge nodes:
  [<start>s-<end>s] <word>
Address everything by node index. NEVER output a timestamp, a second, or an index
you were not shown. The window is padded with surrounding context so you can judge
self-containment and find where a clean sentence actually begins.

Score each candidate 0.0-1.0 for SCROLL-STOPPING potential:
- Would a stranger who never saw the source stop scrolling in the first 2-3 seconds?
- Is there real tension, emotion, curiosity, or payoff - not just information?
- Is it SELF-CONTAINED: does it make full sense with no prior context?
- Does it deliver on its own hook? (No bait it does not pay off.)

COLD VIEWER RULE - the most common failure, check it FIRST:
The viewer sees ONLY the text between your chosen start_node and end_node.
The padded window around the candidate exists so you can FIX boundaries, not so
you can understand the clip - you know the surrounding context, the viewer
never will. A clip FAILS this rule when its opening sentence points at
something said BEFORE start_node: demonstratives and dangling references like
"this", "that", "these", "they", "so that's why", "which is why", "это",
"вот эта", "этот", "они", "поэтому", "тогда". When the opening points
backwards you have exactly two options, in order of preference:
1. Move start_node EARLIER - the window shows you the preceding nodes - so the
   clip CONTAINS the thing being pointed at: the setup, then the reaction.
2. If the needed setup is too long, lies outside the window, or would push the
   clip past ~90s: keep: false. A clip that opens on a dangling pointer is
   worthless to a cold viewer no matter how strong the moment felt in context.
Never "fix" a dangling opening with the title or description - the VIDEO must
make sense on its own, not the caption.
Rhetorical questions are the classic trap: they smell like hooks but usually
interrogate invisible context ("how does THIS affect people?"). A question
hook is valid only when the thing it asks about is shown inside the clip.

For EACH candidate return, in the clip's OWN language ({{LANGUAGE_NAME}}, {{LANGUAGE_ISO}}):

1. keep: false for anything generic, context-dependent, weak-ending, or mid-thought.
   Be strict. A 0.55 is a reject. CONSISTENCY: keep MUST be false whenever you set
   self_contained: false or grounded: false - never keep a clip you yourself flagged.
2. score: your calibrated 0.0-1.0. Judge THIS window in isolation; do not inflate.
3. grounded: true only if the title AND description are fully supported by text inside
   [start_node, end_node]. If you cannot ground a claim, drop it or lower the score.
4. self_contained: true only if the text between start_node and end_node ALONE makes
   full sense to a stranger - apply the COLD VIEWER RULE above; a dangling opening
   pointer means false.
5. Boundary nodes (LENGTH MATCHES THE MOMENT - roughly 8-90s, NEVER pad to a minimum):
   - start_node: the node that begins the opening line (a sentence onset, a clean
     1-2s lead-in is fine; never a dangling pronoun or mid-answer fragment).
   - payoff_node: the node where the punchline / answer / reaction completes.
   - end_node: the FIRST node that finishes a sentence AT or AFTER payoff_node. End on
     a complete sentence. NEVER end before the payoff. Do not trail more than ~4s of
     talk after the payoff - trim filler, goodbyes, topic changes.
   - PAYOFF CHASING: before settling the end, look ~10s past your tentative end_node
     inside the window. If a sharper beat lands there - a punchline, a comeback, an
     emotional reaction - move payoff_node and end_node forward to include it. Never
     end a clip on a definition, a summary, or a dry explanation when the actual
     punchline follows right after it.
   - hook_start_node / hook_end_node: the untouchable core (reaction/punchline). Must
     satisfy start_node <= hook_start_node <= hook_end_node <= end_node.
   Do NOT choose a node marked as music / no-speech as the start or end.
6. title: <= 70 characters, curiosity-driven but TRUTHFUL to what the clip delivers.
   No clickbait the clip does not pay off.
7. description: ONE grounded sentence describing what actually happens. No hype.
8. title_evidence_nodes / description_evidence_nodes: 1-3 node indices each, inside
   [start_node, end_node], containing the words that directly support your title and
   description. If you cannot point at supporting nodes, the copy is not grounded -
   rewrite it or set grounded: false.

Echo "language":"{{LANGUAGE_ISO}}". Include EVERY candidate id, kept or not.
Output ONLY the JSON object described by the schema.`;

export function criticSystemPrompt(languageIso: string, languageName: string): string {
  return CRITIC_PROMPT_TEMPLATE
    .replaceAll("{{LANGUAGE_NAME}}", languageName)
    .replaceAll("{{LANGUAGE_ISO}}", languageIso);
}

export function scannerUserPrompt(windowText: string): string {
  return `Transcript slice:\n\n${windowText}`;
}

// Backward reach exists for the COLD VIEWER RULE: the critic must be able to
// pull a setup that lives well before the scanner's range (a reaction to a
// point made ~a minute earlier). Forward reach exists for payoff chasing.
const CONTEXT_BEFORE = 16;
const CONTEXT_AFTER = 12;

/** Candidate block: context-padded node lines with times. The critic addresses
 *  everything by node index; the [start-end] second markers at each node give it
 *  the timing signal without letting it emit raw seconds. */
export function criticCandidateBlock(
  candidate: MergedCandidate,
  nodes: SentenceNode[]
): string {
  const from = Math.max(0, candidate.startNode - CONTEXT_BEFORE);
  const to = Math.min(nodes.length - 1, candidate.endNode + CONTEXT_AFTER);
  const lines: string[] = [
    `CANDIDATE ${candidate.id} (scanner range #${candidate.startNode}-#${candidate.endNode}, payoff #${candidate.payoffNode}, type ${candidate.type})`,
  ];
  if (candidate.thread && candidate.threadSetupNode !== undefined) {
    lines.push(
      `thread: "${candidate.thread}" - set up around node #${candidate.threadSetupNode}`
    );
  }
  for (let i = from; i <= to; i++) {
    const n = nodes[i];
    lines.push(`#${n.index} [${n.start.toFixed(1)}s-${n.end.toFixed(1)}s] ${n.text}`);
  }
  return lines.join("\n");
}

export function criticUserPrompt(
  batch: MergedCandidate[],
  nodes: SentenceNode[]
): string {
  return batch.map((c) => criticCandidateBlock(c, nodes)).join("\n\n---\n\n");
}
