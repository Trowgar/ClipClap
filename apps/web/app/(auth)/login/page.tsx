import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { AuthCard, AuthShell } from "@/components/auth-shell";
import { LoginForm } from "./login-form";
import { VerifiedNotice, parseVerifiedStatus } from "./verified-notice";

export const metadata: Metadata = {
  title: "Sign in - ClipClap",
};

/**
 * A server component, deliberately, even though everything interactive on it is
 * still the client form below.
 *
 * /api/auth/verify redirects here with ?verified=, and the outcome has to be
 * legible to someone who is ALREADY SIGNED IN - registration signs the user in
 * before the mail can land in their inbox, so the usual reader of ?verified=ok
 * arrives with a session and does not need the sign-in card at all. Knowing
 * that from the client would mean a SessionProvider this app does not mount and
 * a round trip before the acknowledgement appears; `auth()` answers it here for
 * free. Reading `searchParams` server-side also means no useSearchParams, and
 * so no Suspense boundary to forget - the failure mode that only shows up in a
 * production build.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [params, session] = await Promise.all([searchParams, auth()]);
  const verified = parseVerifiedStatus(params.verified);

  return (
    <AuthShell>
      {verified && (
        <VerifiedNotice status={verified} signedIn={Boolean(session?.user?.id)} />
      )}
      <AuthCard>
        <LoginForm />
      </AuthCard>
    </AuthShell>
  );
}
