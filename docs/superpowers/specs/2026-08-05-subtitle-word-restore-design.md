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

To recover the display text, including its punctuation, walk `s.text` counting letters and digits and
cut at the index where the count reaches `flatWords.length`. Never reconstruct it from tokens.

## 4. Where the restored text goes

**Restore into the word list, then chunk.** The recovered text becomes one entry in `words[]` before
`chunkWords` runs, so the chunker's own limits still hold and no cue grows past them. This also keeps
cue boundaries untouched: the first cue's `start` is already `segStart` and the last cue's `end` is
already `segEnd`, so prepending or appending inside the list moves neither.

Timing for the restored entry, using **real segment boundaries and never an invented number**:

- tail: `start = lastWord.end`, `end = segEnd`
- head: `start = segStart`, `end = firstWord.start`

If that leaves less room than `MIN_RESTORED_SEC` (0.08 s), there is no honest timing to give it. In
that case the text is **merged into the adjacent real word** (`last.text + " " + tail`, or
`head + " " + first.text`) rather than synthesised with a made-up duration. The word is then drawn
with its neighbour and the karaoke highlight covers both. Correctness first, karaoke granularity
second.

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

One pure function, exported for testing, in `subtitles.ts` beside `chunkWords`:

```ts
export type RestoreOutcome = "none" | "head" | "tail" | "unresolved";

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
"subtitles": { "segments": 130, "restoredTail": 13, "restoredHead": 1, "unresolved": 0 }
```

Counted per job, summed over its clips. Without it we cannot answer "is the repair still firing, and
has `unresolved` started to grow" - and `unresolved` growing is the signal that Whisper's output
shape has changed.

## 7. Invariants

- A segment whose streams already agree produces **byte-identical** cues to today. This covers 89.3%
  of the corpus and is asserted, not assumed.
- Cue `start` and `end` never move. Only the text and the word list inside a cue change.
- The restored entry never overlaps a real word: it ends where the first real word starts, or starts
  where the last real word ends.
- `chunkWords` limits still hold after restoration, because restoration happens first.
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

**Integration, on `segmentsToCues`:** cue boundaries unchanged against a fixture; chunk limits still
respected once a restored word is present; a segment straddling the window edge is not treated as a
drop.

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
- Whether the chunker should be changed at all, and if so toward longer or shorter cues. Separate
  work, per §2.
- Whether `unresolved` deserves a repair. Two cases in 1265 is not enough to design against, and the
  telemetry in §6 is there to notice if that ever changes.
