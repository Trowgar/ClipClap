# Arabic: a font the renderer can draw with, then a language the bot speaks

**Status:** design, written 2026-08-13. No implementation yet. Every measurement below was taken against
the running `worker-render` container on this host and is reproducible there.

**One sentence.** Arabic-language clips have always shipped with `.notdef` boxes instead of subtitles,
because the renderer carries exactly one font and it has no Arabic glyphs - so the font comes first, and
the bot's Arabic dictionary second.

---

## 1. Why Arabic, and why now

Every bot user ever, excluding the owner, grouped by `telegramLocale`:

| locale | users | of them submitted | jobs | clips |
|---|---|---|---|---|
| en | 29 | 5 (17%) | 6 | 19 |
| ru | 24 | 5 (21%) | 15 | 15 |
| **ar** | **12** | **6 (50%)** | **11** | **20** |
| id (supported) | 8 | 0 | 0 | 0 |
| fa | 5 | 0 | 0 | 0 |
| pt-br (supported via `pt`) | 3 | 1 | 2 | 10 |
| fr | 2 | 1 | 1 | 1 |
| es (supported) | 1 | 1 | 1 | 0 |
| uk (supported) | 1 | 0 | 0 | 0 |
| uz | 1 | 0 | 0 | 0 |

Arabic speakers convert to a submission at 2.5-3x the rate of any other locale and have produced more
clips than any other locale, while reading an interface in a language that is not theirs. That is the
case for the language.

It is not the case for doing the font first. That case is in §2.

**Ukrainian stays.** One user, zero jobs, and it is still supported: this spec adds a language, it does
not remove one.

---

## 2. The defect, measured

### 2.1 What ships today

`apps/worker/assets/fonts/` contains one file: `Montserrat-Bold.ttf`. `DEFAULT_STYLE.fontName` in
`apps/worker/src/processors/subtitles.ts` is the constant `"Montserrat"`. Montserrat covers Latin and
Cyrillic. It has no Arabic.

`fc-list` inside `worker-render` returns **zero fonts** - fontconfig is installed and empty, so there is
no system fallback either.

Probed from R2 with no re-encode, clip `cmsnod8kc005zuhfj95wm65fs` (delivered 2026-08-10 to telegram
`1553741363`): the burned subtitle line reads `[][][] [][][][][][] [][][][][][][]`. Three words, all
`.notdef`. The readable Arabic visible above it in the same frame belongs to the source video, not to us,
and our 9:16 crop clips it at both edges.

**Scale of the damage is small and was initially overstated.** Subtitles follow the *video's* language,
not the user's locale. Only two jobs have ever had `language = 'ar'`:

| job | user | clips | expires |
|---|---|---|---|
| `cmsnod8kc005zuhfj95wm65fs` | `1553741363` | 2 | 2026-08-13 |
| `cmsoarjd00079uhfjfj72esb9` | `8983522218` | 1 | 2026-08-14 |

Three clips, two people. The 12 clips of `1021588991` and the 5 of `7013153761` came from
English-language sources and their subtitles are fine. Fixing the past is nearly moot; the point is that
the next Arabic clip must not be broken.

### 2.2 Why a second font file is not enough

ffmpeg in this image is built with `libass`, `fribidi` and `harfbuzz`, so shaping and bidi are available.
The question was only how libass picks a face. Both branches were run, not reasoned about:

| attempt | result |
|---|---|
| Montserrat **and** an Arabic-capable font in `fontsdir`, `Fontname: Montserrat` | **boxes.** ffmpeg logs `Failed to load fontconfig fonts!` - with no fontconfig database there is no fallback chain to build |
| the same `fontsdir`, `Fontname` set to the Arabic-capable font | **correct.** Letters joined, right-to-left order right, outline applied |

So the font must be named explicitly. libass will not find it on its own.

### 2.3 The font

**Tajawal Bold**, SIL OFL, 59,988 bytes, fetched from `google/fonts`. Rendered through the exact
`DEFAULT_STYLE` at size 100 on a 1080-wide canvas:

- Arabic shapes and orders correctly;
- Latin and digits render **in the same face**, so a cue mixing scripts (`قناة TikTok الرسمية`) has no
  tofu and needs no second font;
- a Bold weight exists, which the style requires (`Bold: -1`).

It joins `Montserrat-Bold.ttf` in `apps/worker/assets/fonts/`, vendored in git exactly as Montserrat is,
with its licence appended to the existing `apps/worker/assets/OFL.txt`. `apps/worker/Dockerfile:42`
already copies the whole `assets` directory, so the production image picks it up with no build change.

### 2.4 Arabic is about half as wide per character

At size 100, `احتاج المزيد من الوقت للتفكير` - 29 characters - occupies roughly 510px of the 1080 frame.
The comment on `MAX_CHUNK_CHARS` records the Cyrillic calibration: 19 characters sit comfortably, 26
touch both edges. Arabic therefore runs at roughly half the Cyrillic width per character, and the current
limit of 18 is not conservative for Arabic - it is wrong in the harmful direction, splitting three-word
phrases that would fit with room to spare.

The exact replacement number is produced by a measurement pass, not guessed here. See §3.2.

---

## 3. Part A - the render path

Independently shippable. Fixes existing users. Touches no bot code.

### 3.1 Font by script

`fontName` stops being a constant and becomes a function of the clip's language, which
`Job.language` already carries from the transcribe stage.

```
ar, fa, ur, ps  ->  "Tajawal"
everything else ->  "Montserrat"
```

The map is keyed on the Arabic **script**, not on `ar` alone. Persian is already in the database (5
users) and one job has already come back with `language = 'fa'`; covering it costs nothing because it is
the same file. Urdu and Pashto are included on the same argument.

### 3.2 Cue length by script

`MAX_CHUNK_CHARS` becomes a value of the same script key, by the same mechanism.

The number is set by measurement, and the target is stated so the measurement has an answer: find the
Arabic character count whose rendered line width matches what 19 Cyrillic characters occupy today - the
"sits comfortably" end of the existing calibration, not the "touches both edges" end. Render Arabic
strings of increasing length through the real `ass` burn, measure the inked width, take that count. The
resulting figure and the strings it was measured on go into the code comment, the way the Cyrillic
number already is.

`MAX_CHUNK_WORDS` stays at 3 for every script. It is a readability decision, not a width one.

### 3.3 What must not change

- **Any non-Arabic clip.** The map returns the literal `"Montserrat"` for them, so the ASS style line is
  identical character for character, so the render is byte-identical.
- Consequently the frozen level-3 baselines of `eval-camera-invariance` stay green. This must be *run*,
  not assumed: the `setsar` change invalidated every one of those md5s, and a red level 3 read as a
  planner regression is a misreading this project has already had to unpick once.
- Geometry, crop planning, cut points, timings, font size, colours, outline, karaoke fill.
- `SUBTITLE_FONTS_DIR`, the `fontsdir=` argument, the Dockerfile.

---

## 4. Part B - the bot's Arabic

### 4.1 The three registries

Adding `"ar"` to `LOCALES` in `packages/shared/src/i18n/locales.ts` turns three `Record<Locale, ...>`
sites into compile errors. That is the complete surface, and the third is easy to miss:

| site | what it holds |
|---|---|
| `apps/bot/src/i18n/index.ts:25` `dictionaries` | the `Dict`: 104 keys, plus a 5-entry `JobErrorCode` map |
| `apps/bot/src/i18n/index.ts:42` `LANG_ALIASES` | what a person may type after `/lang` |
| `packages/shared/src/services/telegram-notification.service.ts:39` `PAYMENT_COPY` | the payment messages |

`PAYMENT_COPY` is the one message a paying user is guaranteed to read. The header comment in
`locales.ts` was written about exactly this hazard.

### 4.2 Register: Modern Standard Arabic

Not a dialect. The audience spans Morocco, Iraq and the Gulf simultaneously; MSA is the only register all
of them read.

### 4.3 Plurals: six forms, not three

Arabic selects every CLDR category. Verified against this project's Node:

| n | category |
|---|---|
| 0 | zero |
| 1 | one |
| 2 | two |
| 3-10, 203 | few |
| 11-99 | many |
| 100, 101, 1000 | other |

No existing dictionary writes more than three forms. The machinery is already right - `PluralForms`
permits all six and `plural()` defers to `Intl.PluralRules` on a full-ICU Node - but every key carrying a
count (`done(n)`, `linkSuccess(n)`, minutes, days, clips) must fill six slots in `ar.ts`. A structural
copy from `en.ts` type-checks and produces nonsense, which is why §6 tests this explicitly.

### 4.4 RTL: two rules

**Interpolated non-Arabic runs are bidi-isolated.** Strings substitute URLs, `@username`, referral codes,
plan names and numbers into Arabic text. In an RTL paragraph the bidi algorithm reorders such a run
together with adjacent punctuation, so a full stop after a link lands at the wrong end. Wrapping the
substituted value in `U+2068` (FIRST STRONG ISOLATE) and `U+2069` (POP DIRECTIONAL ISOLATE) pins it.
A small helper lives in shared; it is used **only** from `ar.ts`.

**Keyboard labels contain no bidi control characters. Ever.** Labels are compared by exact string against
what Telegram echoes back, across all locales at once, in `matchMenuAction`, `matchSettingsAction`,
`matchEarnAction`, `matchReferralAction`, `matchHelpAction` and `matchSupportAction`. An invisible
character inside a label turns a broken button into a silent one. §6 guards this.

One consequence for copy: `⬅️` points the wrong way in an RTL layout. The Arabic back button uses `➡️`.

### 4.5 What else moves

- **`configureBotProfile`** iterates `[undefined, ...LOCALES]`, so it goes from 21 reads to 24. Writes
  still happen only on a difference, so the steady state stays at zero writes - but the first boot after
  this ships performs 3 writes into the `ar` slot. Telegram's 512-character description and
  120-character short-description limits are already asserted per locale.
- **The `/lang` inline picker** grows from six rows to seven. `langName` is `العربية`.
- **`LANG_ALIASES`** gains an `ar` entry, and the other six gain the Arabic words for those languages -
  the aliases belong to the language being *selected*, not to the language they are written in.
- **`detectLocale` needs no change.** It splits on `-`, so `ar-SA`, `ar-EG` and `ar-MA` already resolve
  to `ar`. §6 pins that.

---

## 5. Out of scope

- The web interface. It is English-only by the decision recorded in `CLAUDE.md`, and `LOCALES` does not
  reach it.
- Rewriting the weak welcome copy. It states no minimum duration, never says the video must contain
  speech, and lists "Twitch streams" without distinguishing talk from music - all real, all a separate
  change that belongs to every locale at once, not to Arabic.
- Operator-facing strings. The `❌ ... закрыл диалог поддержки` notification is read by the owner and
  stays Russian.
- Re-rendering the three existing broken clips. Two expire within a day of this being written.
- Making fontconfig work in the image. It would give libass a real fallback chain for every future
  script, but it hands the choice of face to fontconfig instead of to us, and on an empty image it still
  requires installing fonts. Worth revisiting when a third script arrives.

---

## 6. Tests

### 6.1 Already standing

Fourteen existing assertions in `apps/bot/src/__tests__/i18n.test.ts` go red the moment `"ar"` joins
`LOCALES`, among them:

- gives every supported locale a dictionary and a switch confirmation
- has no keyboard label meaning two different things across locales
- has unique menu button labels per locale
- gives every locale a full, non-empty keyboard and command set
- names every supported language distinctly, in itself
- keeps bot description within Telegram's 512-char limit per locale
- keeps bot short description within Telegram's 120-char limit per locale
- exposes a well-formed commands list per locale
- lists every supported locale in the `/lang` usage text
- accepts every locale code as a `/lang` argument
- names the billing cycle in every locale, never as the raw enum
- keeps account linking reachable from settings in every locale

Turning these green is the work. None of them needs to be written.

### 6.2 New, in the suite

- **Arabic plurals, all six categories.** Modelled on the existing Ukrainian test, which exists precisely
  because a copy from `ru.ts` would otherwise pass with Russian endings. Here: 0, 1, 2, 3, 11 and 100
  must produce six distinct strings.
- **`detectLocale`** resolves `ar`, `ar-SA`, `ar-EG`, `ar-MA` to `ar`.
- **No bidi control character in any keyboard label**, over every locale, not only Arabic.
- **No key left in English:** every `ar` string differs from its `en` counterpart. Catches a key the type
  system cannot see is untranslated.

### 6.3 The one that proves the font

A test that renders and looks at pixels, because that is the only thing that would have caught this bug.

`.notdef` boxes are all the same glyph. So two *different* Arabic strings of the same character count,
burned onto the same blank canvas at the same position, render to **identical** rasters under Montserrat,
and to different rasters under a font that has the glyphs:

```
burn "السفير التركي" and "مواجهة دبلوماسية" through the real ass filter
  boxes    -> rasters identical  -> FAIL
  Tajawal  -> rasters differ     -> pass
```

**This test must be mutation-tested before it is trusted.** Point the `ar` entry of the font map back at
`"Montserrat"`; the test has to fail. Two tests in this project have already shipped green and
measuring nothing - see `feedback_test_matches_default` - and a rendering assertion is exactly the shape
that fails that way.

### 6.4 Run, do not assume

`eval-camera-invariance` level 3 must be run after Part A and must stay green, confirming the
byte-identity claim in §3.3.

---

## 7. Rollout

1. **Part A ships.** Then a real Arabic source goes through the pipeline end to end and a frame from the
   result is looked at with human eyes. The pixel test proves "not boxes"; only an eye proves "reads
   right".
2. **Part B ships.** Then every button is pressed once, in the bot, with the interface set to Arabic.
   Do not edit files under `apps/bot/src/` during this window - each `tsx` restart is another boot, and
   each boot re-reads 24 profile fields.
3. **A native speaker reviews the copy.** Message `7013153761` (Fou ad, 5 clips, returned on a second
   day) and `1021588991` (12 clips, the largest Arabic job) through the in-bot support relay and ask them
   to look. This step is not optional: the tests catch empty, duplicated and untranslated strings, and
   catch nothing about text that is comprehensible but wrong.

Step 3 is also the first time the support relay carries a real conversation. It has been live since
2026-07-24 and has never been used.

---

## 8. Known risks

- **Nobody on this side reads Arabic.** Structural tests bound the damage; they do not eliminate it.
  Hence step 3, and hence MSA rather than a dialect nobody here could sanity-check.
- **Tajawal is one opinion about how the subtitles should look.** It was validated for correctness, not
  for taste. If the native reviewer says the face is wrong, it is one file and one string in the map; the
  script-keyed structure survives.
- **The first boot after Part B** writes into Telegram's `setMy*` family, which rate-limits hard. Three
  writes is far inside the limit, but a burst of `tsx` restarts during that window is not.
