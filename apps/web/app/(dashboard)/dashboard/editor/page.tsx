"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ClipEditor } from "@/components/editor/clip-editor";

function EditorContent() {
  const params = useSearchParams();
  const clipId = params.get("clip");

  if (!clipId) {
    return (
      <p className="text-sm text-muted-foreground">
        No clip selected. Open the editor from a clip page.
      </p>
    );
  }

  return <ClipEditor clipId={clipId} />;
}

export default function EditorPage() {
  return (
    <Suspense fallback={null}>
      <EditorContent />
    </Suspense>
  );
}
