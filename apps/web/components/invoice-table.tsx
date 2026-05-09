"use client";

import { useState } from "react";
import { Download, ExternalLink, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { InvoiceRow } from "@clipfast/shared";

const STATUS_STYLES: Record<string, string> = {
  paid: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  open: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  uncollectible: "bg-red-500/10 text-red-400 border-red-500/20",
  void: "bg-muted text-muted-foreground border-border",
  draft: "bg-muted text-muted-foreground border-border",
};

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$",
  EUR: "€",
};

function formatAmount(amount: number, currency: string): string {
  const symbol = CURRENCY_SYMBOL[currency] ?? `${currency} `;
  return `${symbol}${amount.toFixed(2)}`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

interface InvoiceTableProps {
  initialInvoices: InvoiceRow[];
  initialCursor: string | null;
}

export function InvoiceTable({
  initialInvoices,
  initialCursor,
}: InvoiceTableProps) {
  const [invoices, setInvoices] = useState<InvoiceRow[]>(initialInvoices);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor || loading) return;
    setLoading(true);
    setError(null);
    try {
      const page = await api.billing.invoices(cursor);
      setInvoices((prev) => [...prev, ...page.invoices]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load more");
    } finally {
      setLoading(false);
    }
  }

  if (invoices.length === 0) {
    return (
      <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
        No invoices yet. Your billing history will appear here after your first
        payment.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-secondary/30 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Date</th>
              <th className="px-4 py-3 text-left font-medium">Description</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="px-4 py-3 text-left font-medium">Status</th>
              <th className="px-4 py-3 text-right font-medium">Invoice</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {invoices.map((inv) => (
              <tr
                key={inv.id}
                className="transition-colors hover:bg-accent/30"
              >
                <td className="px-4 py-3 text-muted-foreground">
                  {formatDate(inv.createdAt)}
                </td>
                <td className="px-4 py-3">
                  <div className="font-medium">{inv.description}</div>
                  {inv.number && (
                    <div className="text-xs text-muted-foreground">
                      {inv.number}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-medium tabular-nums">
                  {formatAmount(inv.amount, inv.currency)}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded border px-2 py-0.5 text-xs capitalize ${
                      STATUS_STYLES[inv.status] ??
                      "bg-muted text-muted-foreground border-border"
                    }`}
                  >
                    {inv.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {inv.invoicePdf && (
                      <a
                        href={inv.invoicePdf}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        title="Download PDF"
                      >
                        <Download className="h-3 w-3" />
                        PDF
                      </a>
                    )}
                    {inv.hostedUrl && (
                      <a
                        href={inv.hostedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        title="View invoice"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View
                      </a>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}

      {cursor && (
        <div className="flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors hover:bg-accent disabled:opacity-50"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
