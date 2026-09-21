import { SupportChat } from "@/components/support-chat";

export default async function SupportPage({ searchParams }: {
  searchParams: Promise<{ from?: string }>;
}) {
  const from = (await searchParams).from;
  const contextPath = typeof from === "string" && /^\/dashboard(?:\/|$)/.test(from)
    ? from : undefined;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col">
      <div className="mb-5">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Help desk</p>
        <h1 className="text-2xl font-semibold tracking-tight">Support</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          We’ll reply here. This is not a live chat, so replies may take time.
        </p>
      </div>
      <SupportChat contextPath={contextPath} />
    </div>
  );
}
