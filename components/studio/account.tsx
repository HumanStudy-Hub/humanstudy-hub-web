'use client';
import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import type { StudioUser } from '@/lib/studio/types';
import { accountPath } from '@/lib/studio/auth-policy';
import { studioApi } from './client';
import ArrowRight from '@/components/ArrowRight';
import s from './account.module.css';

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
  return (
    <div className={s.page}>
      <section className={s.story} aria-labelledby="account-title">
        <h1 id="account-title">A place for<br />your research.</h1>
        <p>Keep sources, studies and your next question together.</p>
        <Image
          src="/images/folio-account.jpg"
          alt="A sage paper folder keeps source papers, data and charts together beside a notebook and pencil."
          width={1774}
          height={887}
          sizes="(max-width: 700px) 100vw, 650px"
          className={s.illustration}
        />
      </section>

      <section className={s.card} aria-label="Account access">
        {loading ? (
          <p role="status">Loading your account…</p>
        ) : user ? (
          <>
            <h2>{logout ? 'Sign out?' : 'Your account'}</h2>
            <p>{user.email}</p>
            <p>One account for HumanStudy Hub, the desktop app, and the forum.</p>
            {!logout && (
              <nav className={s.accountLinks} aria-label="Account links">
                <Link className={s.back} href={accountPath(returnTo, '/auth/reset?mode=change')}>Change password</Link>
                <Link className={s.back} href="https://forum.humanstudy-hub.com/">Forum</Link>
                <Link className={s.back} href="/build/projects">Your projects</Link>
                <Link className={s.back} href="/contribute#my-contributions">My contributions</Link>
              </nav>
            )}
            <button className={s.button} disabled={busy} onClick={() => void signout()}>
              {busy ? 'Signing out…' : 'Sign out'} <ArrowRight />
            </button>
            {logout && <Link className={s.back} href={returnTo || '/'}>Cancel</Link>}
          </>
        ) : (
          <>
            <nav className={s.tabs} aria-label="Account action">
              <button
                type="button"
                aria-pressed={mode === 'signin'}
                disabled={busy}
                onClick={() => { setMode('signin'); setError(''); }}
              >
                Sign in
              </button>
              <button
                type="button"
                aria-pressed={mode === 'signup'}
                disabled={busy}
                onClick={() => { setMode('signup'); setError(''); }}
              >
                Create account
              </button>
            </nav>
            <h2>{mode === 'signin' ? 'Welcome back.' : 'Create your account'}</h2>
            <p>Use your HumanStudy Hub or desktop account.</p>
            <form onSubmit={authenticate} aria-label={mode === 'signin' ? 'Sign in' : 'Create account'} aria-busy={busy}>
              <label>
                Email
                <input
                  data-private
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label>
                Password
                <input
                  data-private
                  name="password"
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  disabled={busy}
                />
              </label>
              <button className={s.button} disabled={busy}>
                {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'} <ArrowRight />
              </button>
            </form>
            <nav className={s.links} aria-label="Other sign-in options">
              <Link className={s.back} href={accountPath(returnTo, '/auth/reset')}>Forgot password?</Link>
              {pendingEmail && (
                <button className={s.back} disabled={busy || cooldown > 0} onClick={() => void resend()}>
                  {cooldown ? `Resend in ${cooldown}s` : 'Resend confirmation email'}
                </button>
              )}
            </nav>
          </>
        )}
        {error && <p role="alert" className={s.error}>{error}</p>}
        {notice && <p role="status" className={s.message}>{notice}</p>}
      </section>
    </div>
  );
}
