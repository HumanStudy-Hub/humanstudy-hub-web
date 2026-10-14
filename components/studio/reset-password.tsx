"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { StudioApiError, studioApi } from "./client";
import s from "./reset-password.module.css";

type Mode = "request" | "verify" | "password" | "done";
type Recovery = { ready: true; email: string };

export default function ResetPassword({ tokenHash, invalid, changeMode = false }: { tokenHash?: string; invalid: boolean; changeMode?: boolean }) {
  const [mode, setMode] = useState<Mode>(tokenHash && !invalid ? "verify" : "request");
  const [email, setEmail] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [error, setError] = useState(invalid ? "This recovery link is invalid or has expired. Request a new link below." : "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const implicitStarted = useRef(false);

  useEffect(() => {
    // Auth redirects can contain credentials in either location. Scrub both before network work.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const fragmentToken = fragment.get("access_token");
    const fragmentType = fragment.get("type");
    const fragmentError = fragment.has("error") || fragment.has("error_code");
    window.history.replaceState(null, "", changeMode ? "/auth/reset?mode=change" : "/auth/reset");
    if (changeMode) return;
    if (invalid) return;
    if (fragmentError) {
      setError("This recovery link is invalid or has expired. Request a new link below.");
      return;
    }
    if (fragmentToken && fragmentType === "recovery" && !implicitStarted.current) {
      implicitStarted.current = true;
      setBusy(true);
      void studioApi<Recovery>("/api/studio/password", {
        method: "POST",
        body: JSON.stringify({ action: "begin", accessToken: fragmentToken, type: "recovery" }),
      }).then(result => {
        setVerifiedEmail(result.email);
        setMode("password");
      }).catch(cause => {
        setError(cause instanceof Error ? cause.message : "This recovery link is invalid or has expired. Request a new link below.");
        setMode("request");
      }).finally(() => setBusy(false));
    } else if (!fragmentToken && !tokenHash && !implicitStarted.current) {
      implicitStarted.current = true;
      // Refreshing an already-verified recovery page does not consume a link again.
      void studioApi<{ ready: boolean; email?: string }>("/api/studio/password").then(result => {
        if (result.ready && result.email) { setVerifiedEmail(result.email); setMode("password"); }
      }).catch(() => { /* The request form remains available when recovery expired. */ });
    }
  }, [changeMode, invalid, tokenHash]);

  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setInterval(() => setCooldown(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [cooldown]);

  async function requestLink(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || cooldown) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await studioApi<{ sent: true }>("/api/studio/auth", { method: "POST", body: JSON.stringify({ action: "forgot-password", email: email.trim() }) });
      setMessage("If an account matches that address, a reset link is on its way. Check your inbox and spam folder.");
      setCooldown(60);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send a reset link. Please try again.");
      if (cause instanceof StudioApiError && cause.body.error === "rate_limited") setCooldown(60);
    } finally { setBusy(false); }
  }

  async function verify() {
    if (!tokenHash || busy) return;
    setBusy(true); setError("");
    try {
      const result = await studioApi<Recovery>("/api/studio/password", { method: "POST", body: JSON.stringify({ action: "begin", tokenHash }) });
      setVerifiedEmail(result.email);
      setMode("password");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This recovery link is invalid or has expired. Request a new link below.");
      setMode("request");
    } finally { setBusy(false); }
  }

  async function reset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || password.length < 8 || password.length > 128 || password !== confirmation) return;
    setBusy(true); setError("");
    try {
      await studioApi("/api/studio/password", { method: "POST", body: JSON.stringify({ action: "reset", password }) });
      await studioApi("/api/studio/password", { method: "POST", body: JSON.stringify({ action: "clear" }) }).catch(() => undefined);
      setPassword(""); setConfirmation(""); setMode("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update your password. The link may have expired; request a new one and try again.");
    } finally { setBusy(false); }
  }

  async function change(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !currentPassword || password.length < 8 || password.length > 128 || password !== confirmation) return;
    setBusy(true); setError("");
    try {
      await studioApi("/api/studio/password", { method: "POST", body: JSON.stringify({ action: "change", currentPassword, password }) });
      setCurrentPassword(""); setPassword(""); setConfirmation(""); setMode("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change your password. Check your current password and try again.");
    } finally { setBusy(false); }
  }

  return <main className={s.page}>
    <section className={s.card}>
      <p className={s.brand}>HumanStudy-Hub</p>
      {mode === "done" ? <>
        <h1>Password updated.</h1>
        <p>{changeMode ? "Your password has been changed." : "Your password has been changed. Desktop users: return to the app and sign in with your new password."}</p>
        <Link className={s.button} href="/build">{changeMode ? "Back to workspace" : "Sign in"}</Link>
      </> : changeMode ? <>
        <h1>Change your password.</h1>
        <p>Enter your current password to verify your account, then choose a new password.</p>
        <form onSubmit={change}>
          <label>Current password<input data-private type="password" autoComplete="current-password" required value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={busy} /></label>
          <label>New password<input data-private type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
          <small>Use 8 to 128 characters.</small>
          <label>Confirm new password<input data-private type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
          {confirmation && password !== confirmation && <p className={s.error} role="status">Passwords do not match.</p>}
          <button className={s.button} disabled={busy || !currentPassword || password.length < 8 || password.length > 128 || password !== confirmation}>{busy ? "Updating…" : "Change password"}</button>
        </form>
      </> : mode === "password" ? <>
        <h1>Choose a new password.</h1>
        <p>Resetting password for <strong>{verifiedEmail}</strong>.</p>
        <form onSubmit={reset}>
          <label>New password<input data-private type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
          <small>Use 8 to 128 characters.</small>
          <label>Confirm new password<input data-private type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} /></label>
          {confirmation && password !== confirmation && <p className={s.error} role="status">Passwords do not match.</p>}
          <button className={s.button} disabled={busy || password.length < 8 || password.length > 128 || password !== confirmation}>{busy ? "Updating…" : "Update password"}</button>
        </form>
      </> : <>
        <h1>{tokenHash && !invalid && mode === "verify" ? "Reset your password." : "Forgot your password?"}</h1>
        {tokenHash && !invalid && mode === "verify" ? <>
          <p>Verify your recovery link to continue.</p>
          <button className={s.button} onClick={() => void verify()} disabled={busy}>{busy ? "Verifying…" : "Verify reset link"}</button>
        </> : <>
          <p>Enter your account email and we’ll send a password reset link.</p>
          <form onSubmit={requestLink}>
            <label>Email<input data-private type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} disabled={busy} /></label>
            <button className={s.button} disabled={busy || cooldown > 0}>{busy ? "Sending…" : cooldown ? `Try again in ${cooldown}s` : "Send reset link"}</button>
          </form>
        </>}
      </>}
      {error && <p className={s.error} role="alert">{error}</p>}
      {message && <p className={s.message} role="status">{message}</p>}
      {mode !== "done" && <Link className={s.back} href="/build">Back to sign in</Link>}
    </section>
  </main>;
}
