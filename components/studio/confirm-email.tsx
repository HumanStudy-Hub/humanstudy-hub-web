"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { accountPath } from "@/lib/studio/auth-policy";
import { studioApi } from "./client";
import s from "./confirm-email.module.css";

export default function ConfirmEmail({ tokenHash, invalid, returnTo }: { tokenHash?: string; invalid: boolean; returnTo?: string }) {
  const [error, setError] = useState(invalid ? "This link is invalid or has expired. Request another confirmation email from the sign-in page." : "");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Default Supabase templates confirm at Supabase and return an implicit
    // fragment. Discard it: normal password sign-in establishes our server session.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (fragment.has("error") || fragment.has("error_code")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read external auth redirect state once
      setError("This link is invalid or has expired. Request another confirmation email from the sign-in page.");
    }
    window.history.replaceState(null, "", accountPath(returnTo, "/auth/confirm"));
  }, [returnTo]);

  async function confirm() {
    if (!tokenHash || busy) return;
    setBusy(true); setError("");
    try {
      await studioApi("/api/studio/auth", { method: "POST", body: JSON.stringify({ action: "confirm", tokenHash, type: "email" }) });
      window.location.replace(returnTo || "/build/projects");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not confirm your email. Please retry.");
      setBusy(false);
    }
  }

  return <section className={s.card}>
    <h1>{tokenHash ? "Confirm your email." : "Continue to your workspace."}</h1>
    <p>{tokenHash ? "Confirm this email to finish creating your HumanStudy Hub account." : "Sign in with your email and password to continue."}</p>
    {error && <p className={s.error} role="alert">{error}</p>}
    {tokenHash && <button onClick={confirm} disabled={busy}>{busy ? "Confirming…" : "Confirm and continue"}</button>}
    <Link href={returnTo ? accountPath(returnTo) : "/build/projects"} prefetch={false}>{tokenHash ? "Back to sign in" : "Sign in"}</Link>
  </section>;
}
