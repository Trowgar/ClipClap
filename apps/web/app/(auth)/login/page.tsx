import type { Metadata } from "next";
import { redirect } from "next/navigation";
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
  const signedIn = Boolean(session?.user?.id);

  // A signed-in user has no business on the sign-in card: with a live session
  // every provider button silently turns into "link this identity to the
  // current account" (Auth.js linking semantics). That is how a second Google
  // ended up attached to an existing user, and why a Telegram click here died
  // with OAuthAccountNotLinked on 2026-08-06. The one legitimate signed-in
  // reader is the ?verified= acknowledgement - see the component comment above.
  if (signedIn && !verified) redirect("/dashboard");

  return (
    <AuthShell>
      {verified && <VerifiedNotice status={verified} signedIn={signedIn} />}
      {!signedIn && (
        <AuthCard>
          <LoginForm />
        </AuthCard>
      )}
    </AuthShell>
  );
}
