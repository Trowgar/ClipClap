import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AuthCard, AuthShell } from "@/components/auth-shell";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = {
  title: "Set a new password - ClipClap",
  // The URL carries a live credential. It must never end up in an index, in a
  // referrer-driven crawl, or in a search snippet.
  robots: { index: false, follow: false },
};

/**
 * The page sendPasswordResetEmail has been linking to since the mail went live.
 * It was a 404 until now, which made every reset link a dead end.
 *
 * The token is read here rather than with useSearchParams for the same reason
 * as /login: server-side searchParams needs no Suspense boundary, and a missing
 * boundary is a production-build failure that does not show up in dev. Reading
 * it on the server puts the token in the initial HTML, which is where it
 * already is - it arrived in the URL.
 */
export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, session] = await Promise.all([searchParams, auth()]);
  const raw = params.token;
  const token = typeof raw === "string" && raw.length > 0 ? raw : null;

  return (
    <AuthShell>
      <AuthCard>
        <ResetForm token={token} signedIn={Boolean(session?.user?.id)} />
      </AuthCard>
    </AuthShell>
  );
}
