/** Artifact keys are DERIVED, never random.
 *
 *  The download stage runs again on every BullMQ retry. With a randomUUID in
 *  the key each attempt uploaded a fresh full-size object and overwrote the
 *  column, orphaning the previous one - a 2 GB leak per retry that no row
 *  pointed at, so no sweep could ever find it. Derived keys mean a retry
 *  overwrites its own object, and the whole artifact set for a job lives under
 *  one prefix.
 */
export function sourceArtifactKey(userId: string, jobId: string): string {
  return `work/${userId}/${jobId}/source.mp4`;
}

export function normalizedArtifactKey(userId: string, jobId: string): string {
  return `work/${userId}/${jobId}/normalized.mp4`;
}
