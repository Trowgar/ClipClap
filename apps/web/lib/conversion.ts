export function trackConversion(event: string, detail: Record<string, unknown> = {}) {
  void fetch("/api/conversion", {
    method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
    body: JSON.stringify({ event, detail, eventId: crypto.randomUUID() }),
  }).catch(() => {});
}
