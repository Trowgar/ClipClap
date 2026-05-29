"use client";

import { useEffect, useState } from "react";

interface ReferralData {
  code: string | null;
  termsAccepted: boolean;
  payoutMethod: string | null;
  payoutDestination: string | null;
  balance: {
    pendingUsd: number;
    availableUsd: number;
    payoutPendingUsd: number;
    paidUsd: number;
  };
  referrals: Array<{
    id: string;
    createdAt: string;
    plan: string;
    subscriptionStatus: string;
  }>;
}

export default function ReferralsPage() {
  const [data, setData] = useState<ReferralData | null>(null);
  const [method, setMethod] = useState("USDT_TRC20");
  const [destination, setDestination] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const res = await fetch("/api/referrals");
    if (res.ok) setData(await res.json());
  }
  useEffect(() => {
    void load();
  }, []);

  async function acceptTerms() {
    await fetch("/api/referrals/accept-terms", { method: "POST" });
    await load();
  }

  async function saveDestination() {
    setError(null);
    const res = await fetch("/api/referrals/payout-destination", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, destination }),
    });
    if (!res.ok) {
      const body = await res.json();
      setError(body.error ?? "Failed to save");
      return;
    }
    await load();
  }

  if (!data) return <div className="text-[#EDEDED]">Loading...</div>;

  if (!data.termsAccepted) {
    return (
      <div className="mx-auto max-w-2xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Affiliate Program</h1>
          <p className="text-sm text-muted-foreground">
            Earn a share of your referrals&apos; payments, for life.
          </p>
        </div>
        <p className="text-muted-foreground">
          Earn 30% of your referrals&apos; net payments (after payment fees), for life.
          14-day hold. Payouts on the 1st and 15th. $50 minimum. By joining you agree
          to the payout terms and anti-fraud rules.
        </p>
        <button
          onClick={acceptTerms}
          className="rounded bg-white px-4 py-2 font-medium text-black hover:bg-neutral-200 transition-colors"
        >
          Join the program
        </button>
      </div>
    );
  }

  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://clipclap.io";
  const botName = process.env.NEXT_PUBLIC_BOT_NAME ?? "ClipClapBot";
  const webLink = `${base}/?ref=${data.code}`;
  const tgLink = `https://t.me/${botName}?start=ref_${data.code}`;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Affiliate Program</h1>
        <p className="text-sm text-muted-foreground">
          Share your links and earn 30% of net payments for life.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Your links</h2>
        <CopyRow label="Web" value={webLink} />
        <CopyRow label="Telegram" value={tgLink} />
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Balance</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Pending" value={data.balance.pendingUsd} />
          <Stat label="Available" value={data.balance.availableUsd} />
          <Stat label="In payout" value={data.balance.payoutPendingUsd} />
          <Stat label="Paid" value={data.balance.paidUsd} />
        </div>
        <p className="text-sm text-muted-foreground">
          Next payout: 1st / 15th of each month - Minimum payout: $50
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Payout destination</h2>
        {!data.payoutDestination && (
          <p className="text-sm text-yellow-500">
            Not set - set payout details to receive payments.
          </p>
        )}
        <div className="flex gap-2">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            className="rounded bg-neutral-900 px-3 py-2 text-sm border border-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-500"
          >
            <option value="USDT_TRC20">USDT (TRC20)</option>
            <option value="PAYPAL">PayPal</option>
            <option value="BANK">Bank</option>
          </select>
          <input
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder={data.payoutDestination ?? "destination"}
            className="flex-1 rounded bg-neutral-900 px-3 py-2 text-sm border border-neutral-700 focus:outline-none focus:ring-1 focus:ring-neutral-500"
          />
          <button
            onClick={saveDestination}
            className="rounded bg-white px-4 py-2 text-sm font-medium text-black hover:bg-neutral-200 transition-colors"
          >
            Save
          </button>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Referrals</h2>
        {data.referrals.length === 0 ? (
          <p className="text-sm text-muted-foreground">No referrals yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground text-left">
                <th className="pb-2 font-medium">User</th>
                <th className="pb-2 font-medium">Signup</th>
                <th className="pb-2 font-medium">Plan</th>
                <th className="pb-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {data.referrals.map((r) => (
                <tr key={r.id}>
                  <td className="py-2">{r.id.slice(0, 6)}...</td>
                  <td className="py-2">{new Date(r.createdAt).toISOString().slice(0, 10)}</td>
                  <td className="py-2">{r.plan}</td>
                  <td className="py-2">{r.subscriptionStatus}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-neutral-800 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">${value.toFixed(2)}</div>
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 text-sm text-muted-foreground">{label}</span>
      <code className="flex-1 rounded bg-neutral-900 px-3 py-2 text-sm border border-neutral-800 truncate">
        {value}
      </code>
      <button
        onClick={() => navigator.clipboard.writeText(value)}
        className="rounded border border-neutral-700 px-3 py-2 text-sm hover:border-neutral-500 transition-colors"
      >
        Copy
      </button>
    </div>
  );
}
