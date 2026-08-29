import type { SentenceNode, SnappedClip } from "./types";

/** Maximum future context shown to this observation-only audit. */
export const SAFE_END_AUDIT_FORWARD_CONTEXT_SEC = 25;

export const SAFE_END_AUDIT_SYSTEM = `You audit whether an already-cut short clip ends cleanly.

This is observation only: do not rewrite, rank, or change the clip. Read the
clip and its bounded following context. Return safe when its current ending is
complete. Return needs_afterbeat only when a specific following sentence is
needed for the ending to feel complete; use post_payoff_context and its node
index. Return hard_handoff when extending would cross a new question, topic
switch, or unfinished turn. Return not_evaluable when the supplied material
cannot support a decision.

Use only the closed fields in the schema. Do not include explanations, quotes,
or any prose outside the JSON response.`;

function renderNode(node: SentenceNode): string {
  return `#${node.index} [${node.start.toFixed(1)}s-${node.end.toFixed(1)}s] ${node.text}`;
}

/** The only following nodes the audit is allowed to name as an afterbeat. */
export function safeEndAuditForwardContext(
  clip: SnappedClip,
  nodes: SentenceNode[]
): SentenceNode[] {
  return nodes.filter(
    (node) =>
      node.index > clip.finalEndNode &&
      node.end - clip.endSec <= SAFE_END_AUDIT_FORWARD_CONTEXT_SEC
  );
}

/** Renders exact snapped clip content and no more than 25 seconds of forward
 * sentence context measured from its actual final end. */
export function safeEndAuditClipBlock(clip: SnappedClip, nodes: SentenceNode[]): string {
  const own = nodes.slice(clip.finalStartNode, clip.finalEndNode + 1);
  const forward = safeEndAuditForwardContext(clip, nodes);
  return [
    `CLIP ${clip.verdict.id} | current end #${clip.finalEndNode} | ${Math.round(clip.endSec - clip.startSec)}s`,
    "CLIP CONTENT (already shown to the viewer):",
    ...(own.length ? own.map(renderNode) : ["(no readable clip nodes)"]),
    "FOLLOWING CONTEXT (not in the clip; bounded to 25 seconds):",
    ...(forward.length ? forward.map(renderNode) : ["(no following context in the bounded window)"]),
  ].join("\n");
}

export function safeEndAuditUserPrompt(clips: SnappedClip[], nodes: SentenceNode[]): string {
  return clips.map((clip) => safeEndAuditClipBlock(clip, nodes)).join("\n\n---\n\n");
}
