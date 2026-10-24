'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { StudioUser } from '@/lib/studio/types';
import { accountPath } from '@/lib/studio/auth-policy';
import { studioApi } from './client';
import s from './reset-password.module.css';

export default function Account({ returnTo, logout }: { returnTo?: string; logout: boolean }) {
  const [user, setUser] = useState<StudioUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pendingEmail, setPendingEmail] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const continueTo = (destination: string) => window.location.replace(destination);
  useEffect(() => {
    let cancelled = false;
    studioApi<{ user: StudioUser | null }>('/api/studio/auth').then(result => {
      if (cancelled) return;
      setUser(result.user);
      if (result.user && returnTo && !logout) continueTo(returnTo);
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load your account.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [returnTo, logout]);
  useEffect(() => { if (cooldown <= 0) return; const timer = setTimeout(() => setCooldown(value => value - 1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const result = await studioApi<{ user?: StudioUser; requiresEmailConfirmation?: boolean }>('/api/studio/auth', { method: 'POST', body: JSON.stringify({ action: mode, email, password, returnTo }) });
      setPassword('');
      if (result.user && !result.requiresEmailConfirmation) {
        window.location.replace(returnTo || '/account');
      } else { setPendingEmail(email); setCooldown(60); setNotice('Check your email to confirm your account, then continue here.'); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign in.'); }
    finally { setBusy(false); }
  }
  async function signout() {
    setBusy(true); setError('');
    try {
      await studioApi('/api/studio/auth', { method: 'POST', body: JSON.stringify({ action: 'signout' }) });
      window.location.replace(returnTo || '/');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not sign out.'); setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError('');
    try { await studioApi('/api/studio/auth', { method: 'POST', body: JSON.stringify({ action: 'resend', email: pendingEmail, returnTo }) }); setCooldown(60); setNotice('Confirmation email requested. Check your inbox and spam folder.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not resend email.'); }
    finally { setBusy(false); }
  }
  return <main className={s.page}><section className={s.card}>
    <Link href="/" className={s.brand}>HumanStudy Hub</Link>
    {loading ? <p role="status">Loading your account…</p> : user ? <>
      <h1>{logout ? 'Sign out?' : 'Your account'}</h1>
      <p>{user.email}</p><p>One account for HumanStudy Hub, the desktop app, and the forum.</p>
      {!logout && <><Link className={s.button} href={accountPath(returnTo, '/auth/reset?mode=change')}>Change password</Link><Link className={s.back} href="https://forum.humanstudy-hub.com/">Forum</Link><Link className={s.back} href="/build/projects">Your projects</Link></>}
      <button className={s.button} disabled={busy} onClick={() => void signout()}>{busy ? 'Signing out…' : 'Sign out'}</button>
      {logout && <Link className={s.back} href={returnTo || '/'}>Cancel</Link>}
    </> : <>
      <h1>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
      <p>Use your HumanStudy Hub or desktop account.</p>
      <form onSubmit={authenticate}>
        <label>Email<input data-private type="email" required autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} disabled={busy}/></label>
        <label>Password<input data-private type="password" required minLength={8} maxLength={128} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} disabled={busy}/></label>
        <button className={s.button} disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      </form>
      <Link className={s.back} href={accountPath(returnTo, '/auth/reset')}>Forgot password?</Link>
      <button className={s.back} disabled={busy} onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}>{mode === 'signin' ? 'Create account' : 'Already have an account? Sign in'}</button>
      {pendingEmail && <button className={s.back} disabled={busy || cooldown > 0} onClick={() => void resend()}>{cooldown ? `Resend in ${cooldown}s` : 'Resend confirmation email'}</button>}
    </>}
    {error && <p role="alert" className={s.error}>{error}</p>}{notice && <p role="status" className={s.message}>{notice}</p>}
  </section></main>;
}
