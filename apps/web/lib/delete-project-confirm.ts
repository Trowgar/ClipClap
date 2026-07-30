/**
 * The text of the "are you sure" for deleting a project.
 *
 * One copy, shared by the list and the detail page, because the two used to
 * carry byte-identical strings and only one of them would have grown the
 * warning below.
 *
 * THE WARNING IS THE POINT. Deleting a project that is past the transcribe call
 * keeps its charge against the free allowance - the run has cost real money by
 * then and refunding it would be a hole, see settleFreeLedgerOnDelete - and the
 * old dialog said only "This cannot be undone", which reads as being about the
 * clips. A user pasted a wrong link, pressed Delete and lost an hour of their
 * lifetime allowance with nothing on screen having mentioned minutes.
 *
 * `freeSecondsAtRisk` is null whenever the press costs nothing: a paying
 * account, a finished project, or - since 2026-07-30 - a job still PENDING or
 * DOWNLOADING, which now refunds. The server decides that, not this function;
 * see freeSecondsAtRiskByJob.
 */
export function deleteProjectConfirmMessage(
  title: string,
  clipCount: number,
  freeSecondsAtRisk: number | null
): string {
  const subject =
    clipCount > 0
      ? `Delete "${title}" and its ${clipCount} clip${clipCount === 1 ? "" : "s"}?`
      : `Delete "${title}"?`;

  if (!freeSecondsAtRisk || freeSecondsAtRisk <= 0) {
    return `${subject}\n\nThis cannot be undone.`;
  }

  // Rounded up, and to whole minutes, because the allowance is quoted to the
  // user in minutes everywhere else and a warning that undercounts what it is
  // warning about is worse than none. 30 seconds shows as 1 minute.
  const minutes = Math.ceil(freeSecondsAtRisk / 60);
  return (
    `${subject}\n\n` +
    `This project is already being processed, so the ${minutes} minute${
      minutes === 1 ? "" : "s"
    } it reserved from your free allowance will NOT come back.\n\n` +
    `This cannot be undone.`
  );
}
