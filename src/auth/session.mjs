import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { existsSync } from 'node:fs';

const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
export function readAuthConfig(env = process.env, { inDocker = existsSync('/.dockerenv') } = {}) {
  // Only loopback HTTP is automatic in development; public origins always need HTTPS.
  const local = env.NODE_ENV !== 'production' && env.AUTH_ALLOW_INSECURE_LOCALHOST !== 'false';
  function origin(name) {
    const u = new URL(env[name]);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || (u.protocol !== 'https:' && !(local && u.protocol === 'http:' && loopback(u.hostname)))) throw new Error(`${name} must be an HTTPS origin (loopback development excepted)`);
    return u.origin;
  }
  function seconds(key, value, max) {
    const n = Number(env[key] || value);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`Invalid ${key}`);
    return n * 1000;
  }
  const app = origin('APP_PUBLIC_URL');
  const cms = origin('CMS_PUBLIC_URL');
  if (app === cms) throw new Error('CMS and landing must have distinct origins');
  const api = new URL(env.CMS_API_BASE_URL || `${cms}/api`);
  // A browser's localhost is the Docker host, not the landing container.
  // Rewrite only a derived local-development URL, never an explicit override.
  const dockerLocal = !env.CMS_API_BASE_URL && local && inDocker && loopback(api.hostname);
  if (dockerLocal) api.hostname = 'host.docker.internal';
  if (!['http:', 'https:'].includes(api.protocol) || api.username || api.password || api.search || api.hash) throw new Error('Invalid CMS_API_BASE_URL');
  // HTTP internal transports must be explicitly opted into, not silently accepted in production.
  if (api.protocol !== 'https:' && !(local && loopback(api.hostname)) && !dockerLocal && env.SSO_ALLOW_INTERNAL_HTTP !== 'true') throw new Error('CMS API requires HTTPS or explicit trusted-network SSO_ALLOW_INTERNAL_HTTP');
  const clientId = env.SSO_CLIENT_ID || 'landing-page';
  if (!/^[a-z0-9-]{1,64}$/.test(clientId) || !/^[A-Za-z0-9_-]{32,256}$/.test(env.SSO_CLIENT_SECRET || '')) throw new Error('SSO client ID and strong client secret required');
  const previewHost = env.PREVIEW_PUBLIC_HOST || (new URL(app).hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1');
  if (!previewHost || !/^[a-zA-Z0-9.-]+$/.test(previewHost) || previewHost.toLowerCase() === new URL(app).hostname.toLowerCase()) throw new Error('PREVIEW_PUBLIC_HOST must be a different hostname from APP_PUBLIC_URL');
  return { app, cms, api: api.href.replace(/\/$/, ''), clientId, previewHost, secret: env.SSO_CLIENT_SECRET,
    secure: new URL(app).protocol === 'https:',
    transactionTtl: seconds('AUTH_TRANSACTION_TTL_SECONDS', 300, 300),
    sessionTtl: seconds('AUTH_SESSION_TTL_SECONDS', 28800, 28800),
    idleTtl: seconds('AUTH_IDLE_TIMEOUT_SECONDS', 1800, 1800),
    roleTtl: seconds('AUTH_ROLE_CACHE_TTL_SECONDS', 60, 60) };
}
export function localPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20]/.test(value) || value.length > 2048) return '/';
  // Avoid redirecting back to authentication endpoints after completing login.
  if (value.startsWith('/api/')) return '/';
  return value;
}
function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=')).filter(v => v.length === 2));
}
export function createSessionAuth(config, { fetcher = fetch, now = () => Date.now(), maxRecords = 5000 } = {}) {
  const sessions = new Map(), transactions = new Map(), rates = new Map();
  const cookieName = config.secure ? '__Host-landing_session' : 'landing_session_dev';
  const transactionName = config.secure ? '__Host-landing_transaction' : 'landing_transaction_dev';
  const options = { secure: config.secure, httpOnly: true, sameSite: 'lax', path: '/' };
  function sweep() {
    const time = now();
    for (const [k, v] of sessions) if (v.expires <= time || v.lastSeen + config.idleTtl <= time) sessions.delete(k);
    for (const [k, v] of transactions) if (v.expires <= time) transactions.delete(k);
    for (const [k, v] of rates) if (v.expires <= time) rates.delete(k);
  }
  const timer = setInterval(sweep, 30_000); timer.unref();
  function rate(req, res, next) {
    sweep();
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const key = `${req.ip}:${req.path}`;
    let entry = rates.get(key);
    if (!entry) {
      if (rates.size >= maxRecords) return res.status(429).json({ error: 'auth_busy' });
      rates.set(key, entry = { count: 0, expires: now() + 60_000 });
    }
    if (++entry.count > 120) return res.status(429).json({ error: 'too_many_requests' });
    next();
  }
  async function cms(path, body) {
    let result;
    try {
      result = await fetcher(`${config.api}/auth/sso/${path}`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.secret}` },
        body: JSON.stringify({ ...body, client_id: config.clientId }), signal: AbortSignal.timeout(5000) });
    } catch { throw Object.assign(new Error('CMS unavailable'), { status: 503 }); }
    if (!result.ok) throw Object.assign(new Error('CMS rejected authentication'), { status: result.status === 403 ? 403 : [400, 401].includes(result.status) ? 401 : 503 });
    return result.json();
  }
  function csrf(req, session) {
    return req.headers.origin === config.app && equal(req.headers['x-csrf-token'], session.csrf);
  }
  // fresh: true forces a CMS check; a number forces one if the last is older than that many ms.
  async function validate(req, touch = true, fresh = false) {
    const key = hash(cookies(req)[cookieName] || '');
    const session = sessions.get(key);
    if (!session || session.expires <= now() || session.lastSeen + config.idleTtl <= now()) {
      sessions.delete(key); throw Object.assign(new Error('Sign in required'), { status: 401 });
    }
    if (fresh === true || session.checked + (typeof fresh === 'number' ? Math.min(fresh, config.roleTtl) : config.roleTtl) <= now()) {
      // Share pending checks across requests/streams; never reuse stale permissions after failure.
      // issued_at lets CMS revoke this grant when the user signs out of CMS (401).
      session.checking ||= cms('role', { user_id: session.user.id, issued_at: session.issuedAt }).then(({ role }) => {
        if (!['admin', 'marketing', 'intern'].includes(role)) throw Object.assign(new Error('Denied'), { status: 403 });
        session.user.role = role; session.checked = now();
      }).finally(() => { session.checking = null; });
      try { await session.checking; } catch (err) {
        if (err.status === 403 || err.status === 401) sessions.delete(key);
        throw err;
      }
    }
    // A logout or concurrent revocation may have occurred during the network check.
    if (sessions.get(key) !== session || session.expires <= now() || session.lastSeen + config.idleTtl <= now()) {
      sessions.delete(key); throw Object.assign(new Error('Sign in required'), { status: 401 });
    }
    if (touch) session.lastSeen = now();
    return { key, session };
  }
  async function requireSession(req, res, next) {
    try {
      const { session } = await validate(req, false);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrf(req, session)) return res.status(403).json({ error: 'invalid_csrf' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) session.lastSeen = now();
      req.user = session.user;
      res.set('Cache-Control', 'no-store');
      if (req.path.endsWith('/events')) {
        const interval = setInterval(async () => {
          try { await validate(req, false, true); } catch { res.end(); }
        }, Math.max(10, Math.min(config.roleTtl / 2, 10_000)));
        interval.unref();
        res.on('close', () => clearInterval(interval));
      }
      next();
    } catch (err) {
      res.status(err.status || 503).json({ error: err.status === 403 ? 'access_denied' : err.status === 401 ? 'unauthorized' : 'authorization_unavailable' });
    }
  }
  const router = express.Router();
  router.use(rate);
  router.get('/start', (req, res) => {
    if (transactions.size >= maxRecords) return res.status(503).send('Login busy; retry shortly.');
    const old = cookies(req)[transactionName];
    if (old) transactions.delete(hash(old));
    const browser = random(), state = random(), verifier = random();
    transactions.set(hash(browser), { state, verifier, next: localPath(req.query.next), expires: now() + config.transactionTtl });
    res.cookie(transactionName, browser, { ...options, maxAge: config.transactionTtl });
    const url = new URL('/authorize', config.cms);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: `${config.app}/api/auth/callback`, state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
    res.redirect(303, url.href);
  });
  router.get('/callback', async (req, res) => {
    const key = hash(cookies(req)[transactionName] || ''), transaction = transactions.get(key);
    transactions.delete(key);
    res.clearCookie(transactionName, options);
    if (!transaction || transaction.expires <= now() || !equal(req.query.state, transaction.state) || typeof req.query.code !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(req.query.code)) return res.status(400).send('Invalid or expired login. Return to the application and try again.');
    try {
      const { user, issued_at: issuedAt } = await cms('exchange', { code: req.query.code, code_verifier: transaction.verifier, redirect_uri: `${config.app}/api/auth/callback` });
      if (!user || typeof user.id !== 'string' || !['admin', 'marketing', 'intern'].includes(user.role) || typeof issuedAt !== 'number') throw new Error('Invalid identity');
      if (sessions.size >= maxRecords) return res.status(503).send('Session capacity reached. Retry later.');
      // Rotate any previous session to prevent fixation and orphaned sessions.
      sessions.delete(hash(cookies(req)[cookieName] || ''));
      const token = random();
      sessions.set(hash(token), { user, issuedAt, csrf: random(), expires: now() + config.sessionTtl, lastSeen: now(), checked: now() });
      res.cookie(cookieName, token, { ...options, maxAge: config.sessionTtl });
      res.redirect(303, transaction.next);
    } catch (err) { res.status(err.status || 503).send('Sign-in could not complete. Return to the application and try again.'); }
  });
  router.get('/me', async (req, res) => {
    try {
      // ?fresh=1 (tab regained focus): re-check CMS so a CMS sign-out applies at once.
      const { session } = await validate(req, false, req.query.fresh === '1' ? 5000 : false);
      res.json({ user: session.user, csrfToken: session.csrf });
    } catch (err) { res.status(err.status || 503).json({ error: err.status === 403 ? 'access_denied' : err.status === 401 ? 'unauthorized' : 'authorization_unavailable' }); }
  });
  router.post('/activity', requireSession, (_req, res) => res.status(204).end());
  router.post('/logout', async (req, res) => {
    // Logout must work locally even when the CMS is down or a grant was revoked.
    const key = hash(cookies(req)[cookieName] || ''), session = sessions.get(key);
    if (req.headers.origin !== config.app || (session && !csrf(req, session))) return res.status(403).json({ error: 'invalid_csrf' });
    sessions.delete(key); res.clearCookie(cookieName, options);
    // Then end the CMS session too (front-channel). The ticket lets CMS skip its
    // confirmation prompt; without one (CMS down, no session) CMS asks first.
    const redirect = new URL('/logout', config.cms);
    redirect.searchParams.set('client_id', config.clientId);
    if (session) {
      try {
        const { ticket } = await cms('logout-ticket', { user_id: session.user.id });
        if (typeof ticket === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(ticket)) redirect.searchParams.set('ticket', ticket);
      } catch { /* local logout already done */ }
    }
    res.json({ redirect: redirect.href });
  });
  return { router, requireSession, close: () => clearInterval(timer) };
}
