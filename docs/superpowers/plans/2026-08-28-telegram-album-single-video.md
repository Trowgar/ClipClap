# Telegram Album Single-Video Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject every Telegram video album as one batch, send one localized explanation, create zero jobs, and record one refusal.

**Architecture:** Add `MEDIA_GROUP` to the shared refusal vocabulary. At the bot boundary, detect `media_group_id` before `handleVideo`, claim each `(chatId, mediaGroupId)` in a five-minute in-memory map, and let only the first item send the localized reply and telemetry. Existing locale detection provides the English fallback.

**Tech Stack:** TypeScript, Telegram Bot API update types, Vitest, Prisma-backed funnel telemetry.

---

### Task 1: Shared refusal vocabulary

**Files:**
- Modify: `packages/shared/src/services/funnel.service.ts:98-165`
- Test: `packages/shared/src/services/__tests__/funnel.service.test.ts:82-135`

- [ ] **Step 1: Write the failing assertions**

Add beside the route-level rejection assertions:

```ts
expect(uploadRejectedEvent("MEDIA_GROUP")).toBe("upload_rejected_media_group");
```

Also add `"MEDIA_GROUP"` to the `current` code array used to verify distinct non-retired suffixes.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run packages/shared/src/services/__tests__/funnel.service.test.ts
```

Expected: failure because `MEDIA_GROUP` is not an `UploadRejectionCode`.

- [ ] **Step 3: Implement the code and suffix**

Add the literal immediately after `TOO_SHORT`:

```ts
/** A Telegram media group was rejected because the bot accepts one source. */
| "MEDIA_GROUP"
```

Add its mapping:

```ts
MEDIA_GROUP: "media_group",
```

Use only ASCII `-` in new comments.

- [ ] **Step 4: Verify GREEN**

```bash
npx vitest run packages/shared/src/services/__tests__/funnel.service.test.ts
```

Expected: all tests in the file pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/services/funnel.service.ts packages/shared/src/services/__tests__/funnel.service.test.ts
git commit -m "feat(analytics): record Telegram media-group refusals"
```

### Task 2: Localized Telegram album guard

**Files:**
- Modify: `apps/bot/src/types.ts:51-65`
- Modify: `apps/bot/src/handlers.ts:720-770,2497-2540`
- Modify: `apps/bot/src/i18n/types.ts:120-145`
- Modify: `apps/bot/src/i18n/en.ts:140-155`
- Modify: `apps/bot/src/i18n/ru.ts:118-132`
- Modify: `apps/bot/src/i18n/uk.ts:106-120`
- Modify: `apps/bot/src/i18n/es.ts:96-110`
- Modify: `apps/bot/src/i18n/pt.ts:95-109`
- Modify: `apps/bot/src/i18n/id.ts:92-106`
- Modify: `apps/bot/src/i18n/ar.ts:256-270`
- Test: `apps/bot/src/__tests__/funnel.test.ts`

- [ ] **Step 1: Write failing album tests**

Add a helper that builds a video update carrying `media_group_id`, with overridable chat id and language code. Add tests proving:

```ts
await Promise.all([
  handleUpdate(client as never, groupedVideoUpdate("group-one", 301) as never, CONFIG),
  handleUpdate(client as never, groupedVideoUpdate("group-one", 302) as never, CONFIG),
]);

expect(client.sendMessage).toHaveBeenCalledTimes(1);
expect(client.sendMessage).toHaveBeenCalledWith(
  CHAT.id,
  t("ru").mediaGroupSingleVideo
);
expect(refusalsRecorded()).toEqual([
  { code: "MEDIA_GROUP", detail: { source: "file" } },
]);
expect(eventsRecorded()).toEqual(["upload_rejected_media_group"]);
expect(mocks.userCreate).not.toHaveBeenCalled();
expect(mocks.createJob).not.toHaveBeenCalled();
```

Add separate cases for different group ids, the same group id in different chats, and unsupported `language_code: "de"` resolving to:

```ts
expect(client.sendMessage).toHaveBeenCalledWith(
  CHAT.id,
  t("en").mediaGroupSingleVideo
);
```

Use unique group ids in every test because the cache is module-level.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run apps/bot/src/__tests__/funnel.test.ts
```

Expected: failures because the Telegram field, dictionary key, refusal code, and guard do not exist.

- [ ] **Step 3: Extend the types**

Add to `TelegramMessage`:

```ts
media_group_id?: string;
```

Add to `Dict` immediately before `sourceTooShort`:

```ts
/** A Telegram album is rejected because the bot accepts one source at a time. */
mediaGroupSingleVideo: string;
```

- [ ] **Step 4: Add all translations**

Add these exact dictionary values. Every separator is ASCII `-`:

```ts
// en
"I work with one video at a time. You sent several files at once. Send one video as a separate message - not as an album or a group."

// ru
"Я работаю с одним видео за раз. Ты отправил несколько файлов одновременно. Пришли одно видео отдельным сообщением - не альбомом и не подборкой."

// uk
"Я працюю з одним відео за раз. Ти надіслав кілька файлів одночасно. Надішли одне відео окремим повідомленням - не альбомом і не добіркою."

// es
"Trabajo con un video a la vez. Enviaste varios archivos al mismo tiempo. Envía un video en un mensaje separado - no como álbum ni colección."

// pt
"Eu trabalho com um vídeo por vez. Você enviou vários arquivos ao mesmo tempo. Envie um vídeo em uma mensagem separada - não como álbum nem coleção."

// id
"Saya memproses satu video dalam satu waktu. Kamu mengirim beberapa file sekaligus. Kirim satu video sebagai pesan terpisah - bukan sebagai album atau kumpulan."

// ar
"أتعامل مع فيديو واحد في كل مرة. أرسلت عدة ملفات معًا. أرسل فيديو واحدًا في رسالة منفصلة - وليس ضمن ألبوم أو مجموعة."
```

- [ ] **Step 5: Implement claim-before-await behavior**

Add a module-level `Map<string, number>` with a five-minute TTL. The claim helper must:

```ts
const key = `${message.chat.id}:${mediaGroupId}`;
if (recentVideoMediaGroups.has(key)) return false;
recentVideoMediaGroups.set(key, now);
return true;
```

Prune entries older than five minutes before checking the key. Insert before any `await` so concurrent album updates cannot both claim the group.

For the first item only, send `dict.mediaGroupSingleVideo`, swallow send failure, then record:

```ts
await recordUploadRefusal(
  "bot",
  from.id,
  "MEDIA_GROUP",
  { source: "file" },
  from.language_code
);
```

Return `true` for every item with a non-empty `media_group_id`. Call the guard after `getVideoSource(message)` and before `handleVideo`, so every album item exits and no job is created.

- [ ] **Step 6: Verify GREEN**

```bash
npx vitest run packages/shared/src/services/__tests__/funnel.service.test.ts apps/bot/src/__tests__/funnel.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/types.ts apps/bot/src/handlers.ts apps/bot/src/i18n/types.ts apps/bot/src/i18n/en.ts apps/bot/src/i18n/ru.ts apps/bot/src/i18n/uk.ts apps/bot/src/i18n/es.ts apps/bot/src/i18n/pt.ts apps/bot/src/i18n/id.ts apps/bot/src/i18n/ar.ts apps/bot/src/__tests__/funnel.test.ts
git commit -m "feat(bot): reject Telegram video albums once"
```

### Task 3: Full verification

**Files:**
- Verify only: files changed in Tasks 1 and 2

- [ ] **Step 1: Typecheck the bot**

```bash
npm run typecheck -w @clipclap/bot
```

Expected: exit 0. Since every dictionary is typed as `Dict`, this also proves all seven locales define the new key.

- [ ] **Step 2: Run the complete bot test directory and shared funnel test**

```bash
npx vitest run apps/bot/src packages/shared/src/services/__tests__/funnel.service.test.ts
```

Expected: zero failed tests.

- [ ] **Step 3: Scan added implementation lines for long dashes**

```bash
if git diff --unified=0 main...HEAD -- apps/bot/src packages/shared/src | rg -P '^\+.*[\x{2013}\x{2014}]'; then
  echo "new non-ASCII dash found"
  exit 1
else
  echo "new implementation lines use ASCII punctuation"
fi
```

Expected: `new implementation lines use ASCII punctuation`.

- [ ] **Step 4: Check patch hygiene**

```bash
git diff --check main...HEAD
git status --short
```

Expected: no whitespace errors. Only the user's pre-existing unrelated working-tree changes may remain uncommitted.
