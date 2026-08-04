import { isCleanStart } from "./sentence-graph";
import type {
  ExtensionWindow,
  MergedCandidate,
  SentenceNode,
  SnappedClip,
} from "./types";

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
  ¶ #<index> [<start>s-<end>s] <text>
A leading ¶ marks a STRONG BOUNDARY line: the sentence opens after terminal
punctuation, a real pause, or a music break. Lines without ¶ begin mid-flow.
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
A BARE demonstrative counts as a dangling pointer even when the sentence is
grammatically complete: "я считаю ЭТОТ КОНТЕНТ экстремистским" fails when the
clip never shows WHICH content - the reaction has no target. Naming the
referent in the title does NOT fix it; the SPEECH inside the clip must contain
it. Never "fix" a dangling opening with the title or description - the VIDEO
must make sense on its own, not the caption.
Be doubly strict with short clips (under ~15s) that are a single reaction or
opinion sentence: if the thing being reacted to is not inside the clip,
keep: false - no matter how punchy the line sounds.
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
   - start_node: MUST be a ¶ line. The cutter REJECTS clips starting on an
     unmarked line - when the moment's natural start is unmarked, walk UP to the
     nearest ¶ line above it (never a dangling pronoun or mid-answer fragment).
   - HOOK-FIRST: among valid ¶ starts, prefer the STRONGEST opening line - a
     claim, a provocative question, a punch, a striking number, a sharp opinion.
     Weak openings depress the score: connectives ("например", "то есть", "and
     so"), bare demonstratives, names the clip never introduces.
   - payoff_node: the node where the punchline / answer / reaction completes.
   - end_node: the FIRST node that finishes a sentence AT or AFTER payoff_node. End on
     a complete sentence. NEVER end before the payoff. Do not trail more than ~4s of
     talk after the payoff - trim filler, goodbyes, topic changes.
   - PAYOFF CHASING: before settling the end, look past your tentative end_node
     inside the window. If a sharper beat lands within ~10s - a punchline, a
     comeback, an emotional reaction - move payoff_node and end_node forward to
     include it. Never end a clip on a definition, a summary, or a dry
     explanation when the actual punchline follows right after it.
   - ANSWER COMPLETENESS: NEVER end a clip on an unanswered question or an
     unfulfilled promise ("so is it true?", "давайте разберёмся"). The ANSWER is
     the real payoff - extend payoff_node and end_node to it even when 30-90s of
     analysis sits between question and answer, as long as the clip stays within
     ~90s. If the answer is beyond the window or the cap: either cut the clip to
     a self-contained sub-part that ends on a DELIVERED thought, or keep: false.
     A question-and-answer pair is one arc - never ship the question alone.
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
const CONTEXT_AFTER = 20;

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
    // ¶ marks nodes the boundary machine accepts as clip STARTS - the critic
    // must pick start_node from these lines or the clip dies at the cutter.
    const marker = isCleanStart(nodes, i) ? "¶ " : "  ";
    lines.push(`${marker}#${n.index} [${n.start.toFixed(1)}s-${n.end.toFixed(1)}s] ${n.text}`);
  }
  return lines.join("\n");
}

export function criticUserPrompt(
  batch: MergedCandidate[],
  nodes: SentenceNode[]
): string {
  return batch.map((c) => criticCandidateBlock(c, nodes)).join("\n\n---\n\n");
}

/**
 * FINALIZE (spec 2026-07-24 §4.3) - the only prompt in the engine that sees the
 * shipped set as a set, and each clip as a finished product rather than a
 * candidate inside a padded window.
 *
 * Every rule below is a defect the owner found by WATCHING his own clips, and
 * each is phrased from the real failing line rather than in the abstract. That
 * is deliberate: rules 4, 5 and 7 were all nominally covered by a general
 * phrasing the critic already carries ("self-contained", "does it deliver its
 * hook") and shipped anyway, twice, in both eval fixtures. The general phrasing
 * did not work; the concrete failure is what a judge can match against.
 *
 * Note what the finalizer deliberately CANNOT do. It sees only each clip's own
 * nodes - no padded context - so it can never reason about what lies outside a
 * clip, only about whether the arc inside is whole. And its only boundary lever
 * is trim_start_node, which moves a start FORWARD; ends stay code-owned, so no
 * model can cut a delivered payoff for tidiness (spec §11).
 */
export const FINALIZER_PROMPT_TEMPLATE = `You are the final editor of a short-form clip set. Every clip below already
passed a strict per-clip judge. Your job is the judgement NO earlier stage could
make: you see the WHOLE SET at once, and you see each clip's FULL speech.

Each clip arrives as:
  CLIP <id> | score <s> | <duration>s | payoff #<index>
  title / description
  speech: lines of  ¶ #<index> [<start>s] <text>
A leading ¶ marks a line that is a legal clip START. The FIRST line is what the
viewer hears first; the LAST line is where the video cuts off - for the viewer,
nothing before or after the block exists. Address everything by node index.
NEVER output a timestamp or an index you were not shown.

You may move a start FORWARD (trim_start_node) and you may rewrite a title. You
may not move an end, and you may not re-score: the end and the score belong to
earlier stages.

Judge in this order.

1. DUPLICATES ACROSS THE SET. These clips ship together as one batch from one
   video. Would a viewer feel they watched the same thing twice? Judge the
   CLAIM, not the wording: two clips arguing the same point in different
   sentences ARE duplicates, and two clips quoting the same sentence while
   making different points are NOT. Mark the weaker one verdict "drop",
   drop_reason "duplicate", duplicate_of the id of the clip that says it best,
   and shared_claim - the one thing both assert, in a short phrase. Clips that
   share a topic but land different points are not duplicates.

2. TEASER MONTAGE. Interviews often open with a montage of bait phrases cut
   from later in the conversation, truncated by the source editor: half-thoughts
   with no setup and no payoff, jumping between subjects. Drop them with
   drop_reason "teaser_montage" - the complete moment lives later in the video
   and competes on its own.

3. HONEST TITLE. A question title is valid ONLY when the answer is spoken inside
   the clip. A title that asks something the speech never answers is a promise
   the clip does not keep, and the viewer feels cheated at the cut - this is the
   single most common defect in shipped sets. Rewrite it as a truthful statement
   built from the clip's own words and cite title_evidence_nodes: 1-3 node
   indices INSIDE this clip whose words carry the claim. Keep it under 70
   characters. If nothing in the clip can support an honest title, drop with
   "unanswered_title". Never promise what the clip does not deliver, and never
   repair a clip with its caption - the SPEECH has to hold up alone.

4. UNFINISHED ARC: THE PUNCHLINE FELL OUTSIDE THE CLIP. Read the LAST line as
   the viewer experiences it - the video stops there. A clip must end on the
   beat that PAYS OFF, never on the beat that sets one up. A final line that is
   an escalation, one more item in a list, or a straight-faced absurdity is a
   SETUP whenever nothing inside the clip reacts to it: the laugh, the "что?!",
   the answer landed a second later, outside. Grammar is not the test. Real
   failure: a clip ended on "И летающих пауков ядовитых" - a clean, complete
   sentence, so every boundary check passed - while the reaction that makes it
   land, "Летающих пауков? Это откуда?", fell 0.4s after the cut. A last line
   opening on "И ...", "А ещё ...", "And also ..." is a strong tell the list was
   still running. You cannot move the end, so there is no repair: drop with
   "no_payoff".

5. BORROWED OPENING: THE QUESTION FELL OUTSIDE THE CLIP. Ask of the FIRST line -
   what question is this sentence answering, and is that question spoken inside
   the clip? An opening that answers, rebuts, concedes or defends against
   something the clip never says drops the viewer into the middle of an argument
   they cannot see. This is NOT the pronoun rule: the sentence can be perfectly
   concrete, name every referent, and still be a reply to nothing. Real failure:
   a clip opens on "Вообще-то думать это энергозатратно", which answers an
   off-clip "А какие претензии?" - nothing in the clip ever says what was being
   complained about. Tells: an opening with the grammar of a reply - "Вообще-то",
   "Ну потому что", "Да нет", "Просто", "Actually", "Well, because", "No but".
   Repair by moving trim_start_node forward to a ¶ line that states the point on
   its own terms; when no such line exists before the payoff, drop with
   "broken_opening".

6. MEANDERING OPENING. The first line must state what the clip is about. When a
   tangent, a filler exchange, or crosstalk runs before the real topic, set
   trim_start_node to the ¶ line where the topic actually starts. The new
   opening must not point at anything the clip never shows - "это", "вот эта",
   "этот", "они", "this", "that", "they" with no visible referent - and it must
   lie before the payoff. If the meandering never gives way to a topical line,
   drop with "broken_opening".

7. META-INSTRUCTION OPENING. The first seconds must carry content, not announce
   that content is coming. Lines that only manage the conversation - "Вот просто
   резюмируем.", "Давайте по порядку.", "К следующему вопросу.", "Okay, so, to
   recap." - say nothing to a viewer deciding in two seconds whether to keep
   watching. Real failure: a clip spent its first 1.9s on "Вот просто
   резюмируем." before a word of the actual point. Move trim_start_node to the
   first ¶ line that says something. Every second of scaffolding at the top is a
   second of the hook spent on nothing.

8. NO REPETITION INSIDE A CLIP. If the clip states one thought and then restates
   it with no new information, it drags: prefer trimming the start to the
   sharpest formulation. Drop as "redundant" only when the whole clip circles
   one point. Natural emphasis, a rhetorical echo, and a restatement that ADDS
   an angle - a consequence, an example, a number, a concession - are NOT
   repetition. Do not punish them.

9. FINAL VERDICT. Judge each clip as a finished product a stranger will watch
   standalone: does the hook land in the first two seconds, is the payoff
   delivered INSIDE the clip, is the title honest, does it hold together. Drop
   what does not work, with the closest drop_reason; use "incoherent" only when
   nothing more specific fits.

Return EVERY clip id, kept or dropped, with these fields:
- verdict: "ship" or "drop".
- drop_reason: required whenever you drop, null when you ship. One of:
  duplicate, unanswered_title, broken_opening, no_payoff, redundant,
  teaser_montage, incoherent.
- duplicate_of and shared_claim: only with drop_reason "duplicate", else null.
- title: a rewritten title, or null to keep the original.
- title_evidence_nodes: 1-3 node indices inside THIS clip whenever title is
  non-null, else null. A rewrite with no evidence is discarded.
- trim_start_node: a ¶ index inside THIS clip, before its payoff, or null.

Be conservative: dropping a good clip costs more than keeping a mediocre one,
and a repair beats a drop wherever the clip can be repaired. Copy stays in the
clip's own language ({{LANGUAGE_NAME}}, {{LANGUAGE_ISO}}).
Output ONLY the JSON object described by the schema.`;

export function finalizerSystemPrompt(
  languageIso: string,
  languageName: string
): string {
  return FINALIZER_PROMPT_TEMPLATE
    .replaceAll("{{LANGUAGE_NAME}}", languageName)
    .replaceAll("{{LANGUAGE_ISO}}", languageIso);
}

/**
 * One block per clip: full speech, node indices, ¶ start markers.
 *
 * Unlike criticCandidateBlock this renders EXACTLY the clip's own range with no
 * context padding. That is the point of the stage - the judge must see what the
 * viewer sees, and padding would let it "understand" a clip whose arc is broken
 * (rules 4 and 5), which is the exact mistake the critic makes from inside its
 * padded window. The payoff index is in the header because rules 5-7 have to
 * keep a proposed trim before it.
 */
export function finalizerUserPrompt(
  clips: SnappedClip[],
  nodes: SentenceNode[]
): string {
  return clips
    .map((c) => {
      const v = c.verdict;
      const lines = [
        `CLIP ${v.id} | score ${v.score.toFixed(2)} | ${Math.round(c.endSec - c.startSec)}s | payoff #${v.payoffNode}`,
        `title: ${v.title}`,
        `description: ${v.description}`,
        "speech:",
      ];
      const from = Math.max(0, v.startNode);
      const to = Math.min(nodes.length - 1, v.endNode);
      for (let i = from; i <= to; i++) {
        const n = nodes[i];
        const marker = isCleanStart(nodes, i) ? "¶ " : "  ";
        lines.push(`${marker}#${n.index} [${n.start.toFixed(1)}s] ${n.text}`);
      }
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

/**
 * END-EXTENSION (spec 2026-08-04 §3.2) - the one question the engine has no
 * other way to ask: does this moment KEEP GOING.
 *
 * It exists as its own call rather than a paragraph in the critic's prompt, and
 * that is the whole design. The critic is already told to chase a sharper beat
 * within ~10s (CRITIC_PROMPT_TEMPLATE, "PAYOFF CHASING") while judging a batch
 * of candidates against everything else that prompt asks of it, and it does not
 * fire: shipped tail after the payoff is 0.3s - exactly tailHoldSec - on 9 of 12
 * clips of the sitcom-friends fixture, while three independent reviewers reading
 * the full transcript put the right end 17 to 55 seconds later. engine-notes §5a
 * records the same shape once already - a numbered rule in a crowded prompt
 * firing ZERO times across both fixtures while the defect it names sat in the
 * output. So the rule is not restated more loudly anywhere; it is asked on its
 * own, about one clip, with the candidate ends listed.
 *
 * NO LANGUAGE PARAMETER, unlike the critic and finalizer prompts. Those two
 * write copy a viewer reads and must be pinned to the clip's own language; this
 * one emits an index and a `reason` nobody ships. The transcript in the user
 * block carries the language on its own.
 */
export const EXTENSION_SYSTEM = `You decide where a short video clip should END.

You are given a clip that already works: its setup and its payoff are inside it.
Your only question is whether the moment KEEPS GOING - whether a stronger beat
lands in the lines that follow the current end.

Extend when the lines after the end contain:
- the reaction to the payoff (the comeback, the shock, the escalation)
- a second, harder beat that tops the one the clip currently ends on
- the answer to a question the clip ends on

Do NOT extend when the lines after the end are:
- a new subject, a goodbye, or the conversation winding down
- more of the same with nothing added
- anything that would make a viewer check how much is left

Extending a good clip into a flat one is worse than leaving it short. When the
following lines add nothing, say extend: false.

The candidate list is not a menu. The lines are in order and the clip plays
through them: choosing a line means playing EVERY line between the current end
and it. A strong beat four lines later costs the three lines in between, and a
viewer sits through all of them.

Answer with node indices only, chosen from the CANDIDATE list you are shown -
never a timestamp, never an index you were not offered.

For each clip, in this order: id; then reason - one short clause naming the beat
you are reaching for, or why nothing was worth reaching for; then extend; then
end_node, the LAST node to include, echoing the current end when extend is false.

Output ONLY the JSON object described by the schema.`;

/**
 * One block per clip: what it already contains, then the numbered lines it may
 * reach into.
 *
 * The candidate list is CONTIGUOUS and stops at `window.lastNode`. Contiguous
 * because a clip is a range - choosing #9 plays #8 too, so a list with holes in
 * it would describe a clip that cannot be cut. Stopping at lastNode because that
 * is the whole ceiling on the end INDEX: the scene cut, the clock and maxSec are
 * all inside it, so no index printed here is one the gates can turn down for
 * being too far. The window is passed in rather than recomputed so this block
 * and the gate cannot answer that question differently.
 *
 * What the gates can still refuse is a PROPERTY of the node itself - an opaque
 * one, or a mid-clause end - and those stay in the list deliberately. On
 * sitcom-friends 35 of the 105 candidates across 12 clips are such nodes (26
 * opaque, 9 mid-clause, measured with applyExtension itself as the oracle), so
 * a third of this list is a choice that will be turned down. Filtering them out
 * would not have COST an extension - every one of those 12 windows still holds a
 * legal end (min 2, median 6.5) - but it would hide the laughter and the
 * half-sentences between the beats, and those are what the continuation reads
 * like; which index the model then picks is not something that number can settle
 * either way. `refusedBy.opaque_end` and `refusedBy.no_clean_end` are how that
 * decision gets checked against a real run instead of assumed.
 *
 * The `<current end>` line prints its node's text verbatim even when that node
 * is OPAQUE, which is 2 of the 12 shipped sitcom-friends clips - snap keeps an
 * opaque end when the payoff itself is opaque. It reads as an inconsistency
 * against WHAT IT CONTAINS, which filters those nodes out, and it is left alone
 * deliberately: Whisper's segment text is the only text that line has, and
 * "this clip ends in laughter" is precisely the signal that a reaction follows.
 *
 * PARTIAL, exactly like extensionWindow which mints the window it takes:
 * clip.finalEndNode must be a real index into `nodes`. extendClipEnds checks
 * that before a clip is ever offered - it is the last place in this stage where
 * a valid end node is still a caller's obligation rather than a gate.
 */
export function buildExtensionUser(
  clip: SnappedClip,
  nodes: SentenceNode[],
  window: ExtensionWindow
): string {
  const { lastNode } = window;
  // Opaque nodes are skipped in the clip's own text - their transcript is
  // Whisper's segment-level guess at music or crosstalk, which reads as speech
  // the clip does not contain.
  const own = nodes
    .slice(clip.finalStartNode, clip.finalEndNode + 1)
    .filter((n) => n.hasWords)
    .map((n) => n.text.trim())
    .join(" ");
  const lines = [
    `CLIP ${clip.verdict.id} - currently ends at node #${clip.finalEndNode}`,
    `WHAT IT CONTAINS: ${own}`,
    "",
    "CANDIDATE ENDINGS - the LAST line to include. Everything between the " +
      "current end and your choice plays too. Keep the current end by choosing it:",
    `  #${clip.finalEndNode} <current end> ${nodes[clip.finalEndNode].text.trim()}`,
  ];
  for (let i = clip.finalEndNode + 1; i <= lastNode; i++) {
    lines.push(`  #${i} ${nodes[i].text.trim()}`);
  }
  // A legal answer, not a failure: the clip already ends at a scene cut, or the
  // next line is more than the window away. Said out loud because the list above
  // then holds a single line and reads like a formatting accident.
  if (lastNode === clip.finalEndNode) {
    lines.push("  (nothing follows inside this scene - answer extend: false)");
  }
  return lines.join("\n");
}
