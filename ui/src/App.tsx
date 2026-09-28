import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { setCsrfToken } from './api';
import './App.css';

export default function App() {
  const [signedOut] = useState(() => new URLSearchParams(window.location.search).has('signedout'));
  const [user, setUser] = useState<{ email: string; role: string } | null>(null);
  const [message, setMessage] = useState('Checking your session…');
  const [csrf, setCsrf] = useState('');
  const [canLogin, setCanLogin] = useState(false);
  function login() {
    const next = window.location.pathname + window.location.search + window.location.hash;
    window.location.assign(`/api/auth/start?next=${encodeURIComponent(next)}`);
  }
  useEffect(() => {
    sessionStorage.removeItem('campaignCodegenApiSecret');
    let alive = true;
    async function check(redirect: boolean, fresh = false) {
      try {
        const response = await fetch(fresh ? '/api/auth/me?fresh=1' : '/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
        if (!alive) return;
        if (response.ok) {
          const data = await response.json();
          if (!alive) return;
          setUser(data.user); setCsrfToken(data.csrfToken); setCsrf(data.csrfToken); setCanLogin(false);
        } else {
          // A background re-check only acts on a definite sign-out, not a CMS outage.
          if (fresh && response.status !== 401 && response.status !== 403) return;
          setUser(null); setCanLogin(response.status === 401);
          if (response.status === 401 && redirect) { login(); return; }
          setMessage(response.status === 403 ? 'Your account does not have access to this application.' : response.status === 401 ? 'Sign in through CMS to continue.' : 'Cannot verify access right now. Please reload to retry.');
        }
      } catch { if (alive && !fresh) { setUser(null); setMessage('Cannot reach the authentication service. Please reload to retry.'); } }
    }
    if (signedOut) {
      window.history.replaceState(null, '', '/');
      setMessage('You are signed out.'); setCanLogin(true);
    } else void check(true);
    const onExpired = () => { setUser(null); setCanLogin(true); setMessage('Your session ended. Sign in through CMS to continue.'); };
    const onCheck = () => { void check(false); };
    // Returning to this tab (e.g. after signing out in the CMS tab) re-checks immediately.
    const onVisible = () => { if (document.visibilityState === 'visible') void check(false, true); };
    window.addEventListener('session-expired', onExpired);
    window.addEventListener('session-check', onCheck);
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; window.removeEventListener('session-expired', onExpired); window.removeEventListener('session-check', onCheck); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  useEffect(() => {
    if (!user) return;
    let last = 0;
    const activity = () => {
      if (Date.now() - last < 60_000) return;
      last = Date.now();
      void fetch('/api/auth/activity', { method: 'POST', headers: { 'X-CSRF-Token': csrf }, credentials: 'same-origin' }).then(r => {
        if (r.status === 401 || r.status === 403) window.dispatchEvent(new Event('session-check'));
      }).catch(() => {});
    };
    window.addEventListener('pointerdown', activity); window.addEventListener('keydown', activity);
    return () => { window.removeEventListener('pointerdown', activity); window.removeEventListener('keydown', activity); };
  }, [user, csrf]);
  async function logout() {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf }, credentials: 'same-origin' });
      if (!response.ok) throw new Error();
      // Server returns the CMS logout URL; CMS signs out and sends us back to /?signedout=1.
      const { redirect } = await response.json();
      setCsrfToken(''); window.location.assign(typeof redirect === 'string' ? redirect : '/?signedout=1');
    } catch { window.alert('Sign out failed. Please retry.'); }
  }
  if (!user) return <div className="secret-gate"><div className="secret-card"><h1>Campaign Codegen</h1><p role="status">{message}</p>{canLogin && <button onClick={login}>Sign in through CMS</button>}</div></div>;
  return <div className="shell"><header className="topbar"><NavLink to="/" className="brand" end><span className="brand-mark">CC</span>Campaign Codegen</NavLink><nav><NavLink to="/" end>Campaigns</NavLink><NavLink to="/new">New campaign</NavLink><span>{user.email}</span><button onClick={() => void logout()}>Sign out</button></nav></header><main className="content"><Outlet /></main></div>;
}
