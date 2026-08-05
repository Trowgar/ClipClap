# Subtitle Word Restore: The Word Whisper Did Not Time

**Date:** 2026-08-05
**Status:** Draft - awaiting owner review
**Scope:** One function in `apps/worker/src/processors/subtitles.ts` plus one new pure helper beside
it. No new module, no new service, no schema change. Does **not** touch ANALYZE, RENDER's framing,
the queue, or any user-facing surface beyond the pixels of the burned caption.

---

## 1. Problem

`segmentsToCues` builds each cue's text from the word array alone:

```ts
text: chunk.map((w) => w.text).join(" ")   // subtitles.ts:69
```

`s.text` - the transcript sentence - is used only on the fallback path where a segment has no word
timings at all. So any word that Whisper leaves out of `words[]` is **never drawn**. It is in the
transcript, it is in the analysis, it is in the clip's audio, and it is absent from the picture.

### 1.1 Measured corpus-wide, 2026-08-05

Every job in the database that has clips and a transcript: **13 jobs, 1265 segments** lying fully
inside a clip window. Segments only partly inside a window are excluded, so window clipping is never
counted as a drop.

| Language | Segments | First word lost | Last word lost | Other | Total loss |
|---|---|---|---|---|---|
| en | 748 | 10 | **64** | 1 | 10.0% |
| ru | 517 | **53** | 6 | 1 | 11.6% |
| **all** | **1265** | **63** | **70** | 2 | **10.7%** |

**The rate is the same in both languages and the position flips.** English loses the last word of the
sentence; Russian loses the first. Genuine mid-sentence loss is 2 cases in 1265 - it effectively does
not happen.

This corrects a documented claim. `2026-08-04-clip-quality-programme-design.md` §3.6 and the
project's own notes say the loss is "almost always the sentence's last word". That is true of English
only. On Russian, the owner's language and most of the bot audience's, the defect eats the **head**.

### 1.2 What is actually lost

English: `Geller`, `affair`, `Monica` (twice), `fight`, `joke`, `Bing?`, `stupid`, `leave`,
`difficult`, `right`. Russian: `Там`, `Без`, `На`, `Оно`.

Two of the English losses carry the joke:

```
"Feel sorry for it if it ever got in a fight."      -> "fight" never drawn
"Honey, I just don't think that you understood the joke."  -> "joke" never drawn
```

And one produces a second, visible symptom. `"We think Chandler might be having an affair."` loses
`affair`, which leaves the chunk `an` alone on screen - exactly the frame a judge singled out as
*"nonsense on its own"*. Some of the single-word cues in the set are the residue of this defect, not
of the chunker.

### 1.3 Why it outranks the alternatives

| | Black in-point | This |
|---|---|---|
| Frequency | 1 clip in 73 | **10.7% of segments, in every job** |
| On clips real users received | 0 | all 13 jobs |
| Languages | one source | both |
| Can the user repair it? | yes, trim | **no, it is burned into pixels** |

## 2. Non-goals

- **The chunker.** 56 of 285 cues on the measured set are single-word and 33 are four characters or
  shorter. Some of those disappear once the dropped word returns; the rest come from `chunkWords`
  filling greedily to `MAX_CHUNK_WORDS = 3` / `MAX_CHUNK_CHARS = 18`. Changing that alters every cue
  of every clip and needs its own measurement. Owner's decision on 2026-08-05: separate work.
- **Why Whisper omits the timings.** Not diagnosed here, and the repair does not depend on the cause.
- **`your` vs `you're` in clip 07.** Verified in the 2026-08-04 audit as a TRANSCRIBE defect - Whisper
  heard both words the same. Nothing in this design touches it.
- **Backfilling existing clips.** Cues already stored on `Clip.subtitleTrack` keep their losses; only
  new renders and re-renders benefit.

## 3. The rule

For each segment that has a non-empty `words[]`, compare the **concatenated letter-and-digit stream**
of `s.text` against the same stream built from `words[]`:

| Condition | Action |
|---|---|
| streams equal | nothing; output identical to today |
| `flatText.startsWith(flatWords)` | the **tail** is missing - restore it |
| `flatText.endsWith(flatWords)` | the **head** is missing - restore it |
| neither | leave unchanged, count as `unresolved` |

**The comparison is on the character stream, never on token counts, and this is not a stylistic
preference.** Whisper's tokenisation does not agree with its own segment text:

```
text : "It was 5.30 in the morning,"
words: ["It","was","5","30","in","the"]
```

Six tokens against six words, so a count test sees no loss - and `morning` is gone. The reverse trap
also exists: `"Y-O-U-R means you're."` has 3 text tokens and 6 words, because a spelled-out word is
split into letters, and a set comparison reports a phantom loss. **The first measurement made for
this design fell into the second trap and reported 12.3% instead of 10.7%.** Both traps disappear
under a character-stream comparison.

To recover the display text, including its punctuation, walk the NFC form of `s.text` counting letters
and digits and cut at the index where the count reaches `flatWords.length` (see §3.2 for why the form
matters). Never reconstruct it from tokens.

### 3.1 The comparison function, defined exactly

Both sides of every comparison go through one pure helper. It is specified here rather than left to
the implementation because the two traps above are both normalisation failures, and a third would be
found in production rather than in review.

```ts
/** Comparison form only. NEVER rendered, NEVER stored, NEVER shown to a user. */
function comparableText(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}
```

Contract:

- **NFC first**, so a composed and a decomposed `й` compare equal. Not NFKC: that folds compatibility
  forms and would let two visibly different strings compare equal, which is the opposite of what this
  test is for.
- **Case-folded** with locale-independent `toLowerCase`.
- **Unicode letters and digits only**, `\p{L}` and `\p{N}` with the `u` flag. Never `[a-z0-9]`, which
  would erase Cyrillic entirely and make every Russian segment compare as empty.
- **No token counting, no whitespace, no punctuation, no set comparison** anywhere in the decision.
- **Its output is never displayed.** What reaches the viewer is a substring of the NFC form of
  `s.text`, punctuation and casing intact. The comparison form exists to find the cut index, nothing
  more.

Not named `comparableStream`: in this worker "stream" already means a Node `Readable` and, separately,
a gameplay source with a webcam inset (`REFRAME_STREAM`). It is neither.

This is what makes `5.30`, `Bing?`, `Y-O-U-R`, `you're`, `кое-что` and mixed ASCII/Cyrillic text all
behave.

### 3.2 The cut must be taken in the same form the count was produced in

The companion helper `splitAtComparable(text, keepComparable)` returns the two pieces of `text` around
its `keepComparable`-th comparable character. **It slices the NFC form, not the raw input**, and this
is not incidental: the caller spends a count produced by `comparableText`, which normalises. Walking
the raw string instead means counting in one form and cutting in another, and the design cannot have
it both ways - either the input is never decomposed, in which case the `normalize` in `comparableText`
is dead code, or it can be, in which case an unnormalised split lands in the wrong place. Caught in
review of the first implementation, where `splitAtComparable("й хорошо", 1)` returned
`["и", "̆ хорошо"]`: the wrong letter in the head and a bare combining breve opening the tail.

**A combining mark following the cut goes into the head, with the letter it belongs to.** Marks are
not comparable characters, so the cut index lands between a base and its mark. On Devanagari and Thai
this happens even in NFC: `splitAtComparable("कितна समय", 1)` would otherwise open the tail with an
orphan vowel sign, which renders as a dotted circle, while the head loses the diacritic from its last
letter. Both halves are wrong words.

Slicing the NFC form means the restored text is canonically equivalent to the original rather than
byte-identical to it. That is the correct trade: canonical equivalence guarantees identical glyphs,
and the alternative is a cut in the wrong place.

**The count handed to it is in code points.** `splitAtComparable` counts comparable characters as code
points; `String.length` counts UTF-16 units, and the two disagree on every astral letter - CJK
Extension B, mathematical alphanumerics. Caught on the first implementation of §4, where
`comparableText("𠮷").length` is 2 for one letter, so the split ran a character too far and restored
`"ord"` where the text said `"word"`. Callers pass `[...flat].length`, never `flat.length`.

## 4. Where the restored text goes

**Restore into the word list, then chunk.** The recovered text becomes one entry in `words[]` before
`chunkWords` runs.

### 4.1 The restored span is ONE timing entry, and it may hold several words

Measured over the 133 repairable drops in the corpus:

| Lexical words in the restored span | Cases |
|---|---|
| 1 | 125 |
| 2 | 6 |
| 4 | 1 |
| 9 | 1 |

The worst is 36 characters: `"I'm not sure I'm going to be able to"`. So multi-word spans are not a
hypothetical for a future ASR - they are in the data now, and a design that assumes one word is
wrong today.

**The span is still restored as a single timing entry, and it is not split.** Splitting it into
lexical words would require inventing a timestamp per word inside the gap, which §7 forbids and which
this repair has no information to do honestly. The cost is that one entry can exceed
`MAX_CHUNK_CHARS`, and that cost is bounded by what the engine already ships:

```
existing wordless-fallback cues, same corpus: 76 cues
  length min 0, p50 46, p90 94, max 103 chars
  68 of 76 already exceed the 18-char limit
```

A 36-character restored span is **shorter than the median cue this engine draws today** on the
fallback path. It is not a new class of output, and losing nine spoken words is plainly worse than
drawing them on one line.

Consequence, stated rather than hidden: `chunkWords`'s word-count limit applies to **timing entries**,
not to lexical words inside an indivisible restored span, and its character limit is best-effort for
such a span. Splitting the span properly is possible future work and needs a way to time the words
inside it.

### 4.2 The seam: where the cut falls and how the pieces rejoin

Two rules, both measured into existence after the first implementation shipped.

**The span reaches to the timed words, not from the missing ones.** The head span is everything before
the **first** comparable character that belongs to `words[]`; the tail span is everything after the
**last** one. Cutting the head "after the last missing letter" instead leaves punctuation on the wrong
side and drops it: `"Естественно, для человека это проблема."` restores as `Естественно` and the comma
is lost, in 68 of 560 measured head restores.

**Rejoin with a space only where the source had whitespace at that seam.** Whisper splits hyphenated
and apostrophised words into separate tokens, so an unconditional space join inserts a space inside a
word. Measured on the tail branch, 34 of 743:

```
"Это во-первых."       words end "во"  -> span "-первых."  -> "во -первых."
"Alright, see y'all."  words end "y"   -> span "'all."     -> "y 'all."
```

That is visible corruption rather than a cosmetic slip, and it is worse than the defect being repaired
looks to a viewer. Preserving the original separator fixes both examples and leaves `"an affair."`
unchanged, because that seam really did carry a space.

**A span that continues the adjacent word merges, whatever the gap** - because it is not a separate
word, so the question `MIN_RESTORED_SEC` answers ("can this word have its own timing entry") does not
apply to it, and splitting `во` from `-первых.` would also hand half a word its own karaoke highlight.

**Continuation is decided by the whole non-comparable run at the seam, not by its first character, and
the difference is the whole rule.** The first draft of this section tested `/^\s/` on the span and
described the result as "no whitespace at the seam". That is wrong: `", bro."` also begins with a
non-space character and is a comma followed by a separate word. Enumerated over the corpus, **all 45
restores the rule changed were of that shape and none were continuations** - neither `во-первых` nor
`y'all` occurs at a seam anywhere in the data. As written it folded up to 1.16 s of speech into the
previous word's entry and pushed 4 merged entries past `MAX_CHUNK_CHARS`, which `chunkWords` cannot
split. A rule derived from two examples that never occur, firing only on a third shape nobody looked
at.

The correct test is whether the non-comparable run **contains whitespace**: `", "` does and is a word
boundary; `"-"`, `"'"` and `""` do not and are continuations. When it is a boundary, the run glues to
the adjacent word and the remainder becomes its own entry - `"Nice, bro."` restores as `["Nice,",
"bro."]`, keeping the comma attached and giving `bro.` back its real 0.52 s.

Precedence: a continuation merges; a word boundary with room takes its own entry; a word boundary
without room merges.

**A seam with no separator at all merges, and for CJK and Thai that is wrong.** Those scripts never
put whitespace at a seam, so an entire untimed phrase folds into one entry. No heuristic is offered,
because the corpus contains no CJK or Thai and nothing could validate one. Recorded as a known
limitation rather than papered over.

**The span must not repeat punctuation the boundary word already carries.** Whisper attaches
punctuation to word tokens - 2,023 of 75,378 in the corpus - and the span rules anchor on comparable
characters, so neither side can see it:

```
last timed word "жизнь»",  span "» каждый месяц."  ->  "жизнь»» каждый месяц."
first timed word "«Наука",  head span "Он читал «"  ->  "Он читал ««Наука"
```

Zero occurrences today, but 45 tokens carry the enabling shape against 1362 drop boundaries, so it
will happen and it burns a doubled glyph into the video. The span drops the longest overlap its
seam-facing end shares with the adjacent word - for the tail, the longest prefix also a suffix of
`last.text`; the mirror for the head. The tail exposure predates the seam work; the head one was
introduced by the first rule above, in exchange for the 68 lost commas.

### 4.3 Timing

Timing for the restored entry, using **real segment boundaries and never an invented number**:

- tail: `start = lastWord.end`, `end = segEnd`
- head: `start = segStart`, `end = firstWord.start`

If that leaves less room than `MIN_RESTORED_SEC` (0.08 s), there is no honest timing to give it. In
that case the text is **merged into the adjacent real word** (`last.text + " " + tail`, or
`head + " " + first.text`) rather than synthesised with a made-up duration. The word is then drawn
with its neighbour and the karaoke highlight covers both. Correctness first, karaoke granularity
second.

**Measured after implementation, and it inverts what this section assumed.** Over the 743 real tail
drops in the database:

| | count | share |
|---|---|---|
| merged into the neighbour | 698 | **94%** |
| given its own timing entry | 45 | 6% |

**The gap is exactly 0.000 in 698 cases and at least 0.08 in the other 45. Nothing lands strictly
between.** Whisper's last timed word either ends precisely on the segment boundary or leaves a large
untimed span. So the merge is the ordinary path and the separate entry is the exception - the reverse
of how this design described them.

**The head side is not the same, and the difference matters.** Measured over 560 head drops:

| head gap | count |
|---|---|
| exactly 0.000 | 500 |
| inside `(0, 0.08)` - merges | **14** |
| `[0.08, 0.2)` | 17 |
| `[0.2, 0.5)` | 19 |
| `>= 0.5` | 10 |

Fourteen real segments sit inside the band the tail side left empty, the smallest gap being 0.020. So
**`MIN_RESTORED_SEC` is load-bearing on the head branch and inert on the tail**: moving it anywhere in
0.021 to 0.08 changes what real head segments do and changes nothing at all for tails. An earlier
draft of this section, written from the tail measurement alone, said the value was not load-bearing
full stop. It is a good example of why a distribution measured on one branch must not be quoted about
another.

Also measured there: **560 head drops against 743 tail, so the head is 43% of the defect**, and 136 of
those head drops are in English jobs. The "English loses the tail, Russian the head" split in §1.1 is
a strong tendency measured over clip-window segments, not a dichotomy over whole transcripts.

The practical consequence is that **94% of restored words carry no word-level karaoke granularity of
their own** - they highlight together with the word they were glued to. The text is drawn for the
right duration either way, because the cue holding it runs to the segment end.

**Order of operations, and it is load-bearing.** Reconciliation runs on the raw segment, against the
whole of `s.text`, **before** the existing filter that clips words to the clip window. Reconciling
after the filter would read every partially-overlapping segment as a drop and append text that the
window deliberately excluded.

```
segment -> restoreDroppedWords(text, words, segStart, segEnd)   // new, pure
        -> filter to [clipStart, clipEnd] and shift             // unchanged
        -> chunkWords                                            // unchanged
        -> cues                                                  // unchanged
```

## 5. Component

Two pure functions, exported for testing, in `subtitles.ts` beside `chunkWords`:

```ts
export type RestoreOutcome = "none" | "head" | "tail" | "unresolved";

/** Comparison form only - see §3.1. Never rendered, never stored. */
export function comparableText(value: string): string;

export function restoreDroppedWords(
  text: string,
  words: SubtitleWord[],
  segStart: number,
  segEnd: number
): { words: SubtitleWord[]; outcome: RestoreOutcome };
```

Absolute segment times in, absolute times out; the existing `shiftWord` still does the windowing
afterwards. No filesystem, no clock, no ffmpeg - every branch of §3 and §4 is one unit test.

`segmentsToCues` gains two lines: call it, use its `words`.

## 6. Telemetry

`renderManifest` gains a `subtitles` block beside `reframe`:

```json
"subtitles": { "segmentOccurrences": 130, "restoredTail": 13, "restoredHead": 1, "unresolved": 0 }
```

**`segmentOccurrences`, not `segments`, and the distinction is measured.** The counter increments
once per (clip, segment) pair, so a source segment falling inside two clips is counted twice. In the
corpus behind §1.1 that happens to **6 occurrences out of 1265** - small, but a rate computed against
"unique transcript segments" would be quietly wrong, and the name is what stops someone reading it
that way a month from now.

Counted per job, summed over its clips. Without it we cannot answer "is the repair still firing, and
has `unresolved` started to grow" - and `unresolved` growing is the signal that Whisper's output
shape has changed.

**Open for Task 6, raised by the §4.2 measurement:** `outcome` returns `"tail"` whether the text got
its own timing entry or was glued onto its neighbour, and those are 6% and 94% of real cases. A
metric built on this enum would report that drops are being repaired without revealing that almost
all of them lose word-level karaoke granularity. Either a fifth outcome or a `merged` boolean beside
it closes that; deferred deliberately, because Task 6 owns telemetry and changing the enum earlier
would churn the tests of Tasks 2 through 4 for a distinction nothing yet consumes.

## 7. Invariants

- A segment whose streams already agree produces **byte-identical** cues to today. This covers 89.3%
  of the corpus and is asserted, not assumed.
- For a **restored** segment, the outer window is unchanged - the first cue still starts at `segStart`
  and the last still ends at `segEnd` - but the **internal** chunk boundaries may move, and the cue
  count may change. This is not a defect and it cannot be avoided: `chunkWords` re-chunks the whole
  list, so inserting an entry at the head of `[A,B,C,D,E]` turns `[A,B,C][D,E]` into `[H,A,B][C,D,E]`.
  An earlier draft of this design claimed all boundaries were preserved; that was wrong, and paying
  this price is what keeps the chunker's limits meaningful for the timed words.
- The restored entry never overlaps a real word: it ends where the first real word starts, or starts
  where the last real word ends.
- `chunkWords` limits hold for **timing entries**. A restored span is one indivisible entry that may
  contain several lexical words and may exceed the character limit, bounded per §4.1.
- No cue is ever produced with `end <= start` - `generateAss` already drops those, and the
  `MIN_RESTORED_SEC` branch exists so this path is never reached by a restored word.
- The repair never invents a timestamp. It uses the segment's own boundaries or it merges.

## 8. Testing

**Unit, on `restoreDroppedWords`**, each case taken verbatim from the measured corpus so the tests
carry real data rather than invented strings:

| Case | Input | Expect |
|---|---|---|
| tail drop | `"We think Chandler might be having an affair."` / 7 words | `affair.` restored, outcome `tail` |
| head drop | `"Там хорошая компания подбирается."` / 3 words | `Там` restored, outcome `head` |
| token count coincides | `"It was 5.30 in the morning,"` / `["It","was","5","30","in","the"]` | `morning,` restored |
| spelled-out letters | `"Y-O-U-R means you're."` / `["Y","O","U","R","means","you're"]` | outcome `none`, words untouched |
| already complete | any matching pair | outcome `none`, **same array identity or deep-equal** |
| no room for a timing | last word ends at `segEnd` | merged into the neighbour, no zero-length word |
| unresolved | loss at both ends | outcome `unresolved`, words untouched |
| empty words | `words: []` | untouched; the caller's existing fallback renders `s.text` |
| multi-word span | the measured 9-word case, `"I'm not sure I'm going to be able to"` | restored as **one** entry, text exact including the apostrophes |
| Cyrillic | `"кое-что новое"` style input | not mangled; proves the regex is `\p{L}` and not `[a-z]` |

**Unit, on `splitAtComparable`:** the cut is taken in NFC (`"й хорошо"` decomposed splits after the
whole letter, not between it and its breve); a combining mark following the cut joins the head, not
the tail (Devanagari, Thai); an astral character is never cut in half; `head + tail` reconstructs the
NFC form for every input and count.

**Unit, on `comparableText`:** composed against decomposed `й` compare equal; a Cyrillic string
does not reduce to empty; `"5.30"` and `"5" + "30"` agree; the returned value is never used as
display text anywhere in the module (asserted by the callers' tests, which compare against exact
substrings of the input).

**Integration, on `segmentsToCues`:**

- a segment with no loss produces byte-identical cues, including every internal boundary;
- a **restored** segment keeps its outer window (`first.start === segStart`, `last.end === segEnd`)
  while its internal boundaries and cue count are free to change - the test asserts the outer window
  and the full concatenated text, deliberately **not** the internal split, because §7 permits it to
  move;
- a segment straddling the window edge is not treated as a drop.

**Corpus verification, and it is the acceptance test.** Measure the **cues**, not the transcript.
The repair runs when cues are built and never rewrites `transcriptJson`, so re-running the §1.1
script after the change would still report 133 on a perfectly repaired engine - it reads `words[]`,
which nothing here touches. That mistake was made once while writing this spec and is recorded so it
is not made again.

The acceptance test therefore calls `segmentsToCues` over all 13 jobs' stored transcripts and clip
windows - free, pure, no render required - and compares the concatenated letter stream of the
**resulting cue text** against the same stream from `s.text`:

**This metric has been run in its "before" state and returns exactly what §1.1 predicts**, which is
what makes it usable as an acceptance test rather than a hope:

```
segments measured             : 1265
cue text carries the sentence : 1130
cue text INCOMPLETE           : 135   (10.7%)
```

- before the change: **135 of 1265** - the 133 head/tail drops plus the 2 `unresolved`;
- after: **2**, the `unresolved` pair being the only permitted survivors;
- and the 1130 already-complete segments must produce **identical cue text**, which is the §7
  invariant measured rather than asserted.

**Regression:** existing subtitle tests pass unchanged.

## 9. Rollout

**No feature flag, deliberately.** This is a defect repair with a deterministic output, a corpus-wide
acceptance number, and a rollback that is a `git revert` - and the worker hot-reloads bind-mounted
source, so a revert is live immediately. A flag here would mean shipping the defect switched on by
default. The killswitch convention in this repo exists for engine behaviour whose quality is a
judgement call (`REFRAME_STREAM`, `ANALYZE_ENGINE`, end extension); "draw the word the speaker said"
is not one. If the owner disagrees, the flag is three lines and the rest of the design is unchanged.

Ship, then re-render the measured clip set and confirm the burned pixels carry the restored words -
the acceptance number proves the cue data, and only a rendered frame proves the picture.

## 10. What this design does not settle

- Whether the restored word should get its own karaoke highlight in the merge branch. It does not
  today; the branch is rare and the alternative needs an invented duration.
- **How to time the words inside a multi-word restored span**, which is what would let §4.1 split it
  and bring it back under the chunker's character limit. 8 of 133 spans hold more than one word and
  the worst holds nine. Needs a source of per-word timing that this repair does not have; forcing an
  even split would be exactly the invented timestamp §7 forbids.
- Whether the chunker should be changed at all, and if so toward longer or shorter cues. Separate
  work, per §2.
- Whether `unresolved` deserves a repair. Two cases in 1265 is not enough to design against, and the
  telemetry in §6 is there to notice if that ever changes.
