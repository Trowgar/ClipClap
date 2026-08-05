/** stdout+stderr cap for every child process this worker spawns.
 *
 *  WHY THIS IS A SHARED CONSTANT AND NOT A LOCAL LITERAL. Node's default is
 *  **1 MiB per stream**, and when a child crosses it Node does not truncate -
 *  it SIGTERMs the process and rejects with `stderr maxBuffer length exceeded`.
 *  The job then fails for a reason that has nothing to do with the user's
 *  video, after every expensive stage has already been paid for.
 *
 *  That is not hypothetical. On 2026-08-04 job `cmsfbbl0x000dbxaduyy6o3ie` -
 *  the first YouTube link a real user ever got through, 26 minutes fetched
 *  correctly through WARP - completed DOWNLOAD, TRANSCRIBE and ANALYZE and then
 *  died here in RENDER. The user got nothing.
 *
 *  It had already been found and fixed TWICE, locally, in
 *  `processors/download.ts` and in `reframe/shots.ts` / `reframe/faces.ts` -
 *  each time as a literal beside the call that happened to blow up. The render
 *  path was never touched, because nothing tied the three together. A constant
 *  everyone imports is what makes the next call site inherit the fix instead of
 *  rediscovering the bug.
 *
 *  ffmpeg is the reason it is stderr rather than stdout: it writes its banner,
 *  every warning and continuous per-frame progress there. How much it emits
 *  scales with the SOURCE - its codec quirks, its warnings, its length - so a
 *  short test video will not reach the cap and a real user's upload will. That
 *  asymmetry is exactly why this hid for so long.
 *
 *  16 MiB is the value the two earlier fixes converged on independently. An
 *  unused buffer is not allocated up front, so the ceiling costs nothing until
 *  a child is actually chatty enough to need it.
 */
export const CHILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
