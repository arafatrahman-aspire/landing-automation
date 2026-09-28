import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'node:crypto';
import { createSessionAuth, localPath, readAuthConfig } from '../src/auth/session.mjs';
const config = { app: 'https://landing.test', cms: 'https://cms.test', api: 'https://cms-api.test', clientId: 'landing-page', secret: 's'.repeat(40), secure: true, transactionTtl: 300000, sessionTtl: 28800000, idleTtl: 1800000, roleTtl: 60000 };
async function fixture(t, options = {}) {
  let time = 1000, role = 'admin', available = true, exchanges = 0, roleChecks = 0;
  const auth = createSessionAuth(config, { ...options, now: () => time, fetcher: async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${config.secret}`);
    assert.equal(options.redirect, 'error');
    if (!available) throw new Error('offline');
    const body = JSON.parse(options.body);
    assert.equal(body.client_id, 'landing-page');
    if (url.endsWith('/exchange')) { exchanges++; assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge); }
    if (url.endsWith('/role')) { roleChecks++; assert.equal(body.issued_at, 1234.5); }
    if (url.endsWith('/logout-ticket')) { assert.equal(body.user_id, 'user'); return new Response(JSON.stringify({ ticket: 't'.repeat(43) })); }
    return new Response(JSON.stringify(url.endsWith('/exchange') ? { user: { id: 'user', email: 'test@test.test', role }, issued_at: 1234.5 } : { role }), { status: role === 'removed' ? 403 : role === 'signedout' ? 401 : 200 });
  }});
  const app = express(); app.use(express.json()); app.use('/api/auth', auth.router);
  app.use('/api/campaigns', auth.requireSession);
  app.all('/api/campaigns', (req, res) => res.json({ user: req.user }));
  app.get('/api/campaigns/run/events', (_req, res) => { res.type('text/event-stream'); res.write(': connected\n\n'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { auth.close(); server.closeAllConnections(); server.close(); });
  const request = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
  let challenge;
  async function start(next = '/runs/123') {
    const r = await request('/api/auth/start?next=' + encodeURIComponent(next));
    const url = new URL(r.headers.get('location')); challenge = url.searchParams.get('code_challenge');
    return { cookie: r.headers.get('set-cookie').split(';')[0], state: url.searchParams.get('state') };
  }
  async function login() {
    const tx = await start();
    const r = await request(`/api/auth/callback?code=${'c'.repeat(43)}&state=${tx.state}`, { headers: { Cookie: tx.cookie } });
    assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/runs/123');
    const cookie = r.headers.getSetCookie().find(c => c.startsWith('__Host-landing_session=')).split(';')[0];
    const me = await request('/api/auth/me', { headers: { Cookie: cookie } });
    const { csrfToken } = await me.json();
    return { cookie, csrfToken, response: r };
  }
  return { request, start, login, advance: ms => time += ms, role: value => role = value, offline: () => available = false, exchanges: () => exchanges, roleChecks: () => roleChecks };
}

test('browser binding, secure cookies, CSRF, logout, old key rejection', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/campaigns', { headers: { Authorization: 'Bearer old-api-key' } })).status, 401);
  const tx = await f.start();
  assert.equal((await f.request(`/api/auth/callback?code=${'c'.repeat(43)}&state=${tx.state}`)).status, 400);
  assert.equal(f.exchanges(), 0);
  const { cookie, csrfToken, response } = await f.login();
  assert.match(response.headers.get('set-cookie'), /HttpOnly/); assert.match(response.headers.get('set-cookie'), /Secure/);
  assert.equal((await f.request('/api/campaigns', { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await f.request('/api/campaigns', { method: 'POST', headers: { Cookie: cookie, Origin: config.app } })).status, 403);
  const headers = { Cookie: cookie, Origin: config.app, 'X-CSRF-Token': csrfToken };
  assert.equal((await f.request('/api/campaigns', { method: 'POST', headers })).status, 200);
  assert.equal((await f.request('/api/campaigns', { method: 'POST', headers: { ...headers, Origin: 'https://evil.test' } })).status, 403);
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).redirect, `${config.cms}/logout?client_id=landing-page&ticket=${'t'.repeat(43)}`);
  assert.equal((await f.request('/api/campaigns', { headers })).status, 401);
});

test('logout ends the local session even when CMS is down, and still hands off to CMS', async t => {
  const f = await fixture(t); const { cookie, csrfToken } = await f.login(); f.offline();
  const headers = { Cookie: cookie, Origin: config.app, 'X-CSRF-Token': csrfToken };
  const logout = await f.request('/api/auth/logout', { method: 'POST', headers });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).redirect, `${config.cms}/logout?client_id=landing-page`);
  assert.equal((await f.request('/api/auth/me', { headers })).status, 401);
});

test('role revocation, outage, expiry and no passive idle extension', async t => {
  const f = await fixture(t); const { cookie } = await f.login(); const headers = { Cookie: cookie };
  f.advance(60001); f.role('removed');
  assert.equal((await f.request('/api/campaigns', { headers })).status, 403);
  f.role('admin'); assert.equal((await f.request('/api/campaigns', { headers })).status, 401);
  const second = await f.login(); f.advance(60001); f.offline();
  assert.equal((await f.request('/api/campaigns', { headers: { Cookie: second.cookie } })).status, 503);
  f.advance(config.idleTtl);
  assert.equal((await f.request('/api/auth/me', { headers: { Cookie: second.cookie } })).status, 401);
});

test('transaction expiry and replay fail', async t => {
  const f = await fixture(t); const tx = await f.start(); f.advance(config.transactionTtl + 1);
  assert.equal((await f.request(`/api/auth/callback?code=${'c'.repeat(43)}&state=${tx.state}`, { headers: { Cookie: tx.cookie } })).status, 400);
  assert.equal(f.exchanges(), 0);
  const next = await f.start(); const url = `/api/auth/callback?code=${'c'.repeat(43)}&state=${next.state}`;
  assert.equal((await f.request(url, { headers: { Cookie: next.cookie } })).status, 303);
  assert.equal((await f.request(url, { headers: { Cookie: next.cookie } })).status, 400);
});

test('strict return paths and environment validation', () => {
  for (const value of ['//evil.test', '/\\evil.test', '/api/auth/start', 'https://evil.test', '/\n/evil.test']) assert.equal(localPath(value), '/');
  assert.equal(localPath('/runs/1?x=1'), '/runs/1?x=1');
  const env = { APP_PUBLIC_URL: config.app, CMS_PUBLIC_URL: config.cms, CMS_API_BASE_URL: config.api, SSO_CLIENT_ID: config.clientId, SSO_CLIENT_SECRET: config.secret, PREVIEW_PUBLIC_HOST: 'preview.test' };
  assert.equal(readAuthConfig(env).roleTtl, 60000);
  assert.throws(() => readAuthConfig({ ...env, PREVIEW_PUBLIC_HOST: 'landing.test' }));
  assert.throws(() => readAuthConfig({ ...env, SSO_CLIENT_SECRET: 'short' }));
  assert.throws(() => readAuthConfig({ ...env, AUTH_ROLE_CACHE_TTL_SECONDS: '61' }));
});

test('passive reads do not extend idle expiry and session has absolute expiry', async t => {
  const f = await fixture(t); const { cookie, csrfToken } = await f.login();
  const headers = { Cookie: cookie, Origin: config.app, 'X-CSRF-Token': csrfToken };
  f.advance(config.idleTtl - 1);
  assert.equal((await f.request('/api/campaigns', { headers })).status, 200);
  f.advance(2);
  assert.equal((await f.request('/api/campaigns', { headers })).status, 401);
  const second = await f.login();
  const activeHeaders = { Cookie: second.cookie, Origin: config.app, 'X-CSRF-Token': second.csrfToken };
  for (let i = 0; i < 31; i++) {
    f.advance(config.idleTtl / 2);
    assert.equal((await f.request('/api/auth/activity', { method: 'POST', headers: activeHeaders })).status, 204);
  }
  f.advance(config.idleTtl / 2 + 1);
  assert.equal((await f.request('/api/auth/me', { headers: activeHeaders })).status, 401);
});

test('active streams close after role removal', async t => {
  // Use a short real interval to verify the stream timer, not only ordinary requests.
  const short = { ...config, roleTtl: 100 };
  let revoked = false;
  const auth = createSessionAuth(short, { fetcher: async url => new Response(JSON.stringify(url.endsWith('/exchange') ? { user: { id: 'u', role: 'admin' }, issued_at: 1 } : { role: 'admin' }), { status: revoked ? 403 : 200 }) });
  const app = express(); app.use(express.json()); app.use('/api/auth', auth.router);
  app.get('/api/campaigns/r/events', auth.requireSession, (_req, res) => { res.type('text/event-stream'); res.write(': connected\n\n'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => { auth.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const start = await fetch(base + '/api/auth/start', { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const callback = await fetch(base + `/api/auth/callback?code=${'c'.repeat(43)}&state=${state}`, { redirect: 'manual', headers: { Cookie: start.headers.get('set-cookie').split(';')[0] } });
  const cookie = callback.headers.getSetCookie().find(v => v.startsWith('__Host-landing_session=')).split(';')[0];
  const response = await fetch(base + '/api/campaigns/r/events', { headers: { Cookie: cookie }, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); revoked = true;
  assert.equal(await response.text(), ': connected\n\n');
  assert.equal((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).status, 401);
});

test('session store is bounded and restart does not accept previous sessions', async t => {
  // Fresh middleware instances have no persisted state, even with identical configuration.
  const f = await fixture(t); const { cookie } = await f.login();
  const fresh = await fixture(t);
  assert.equal((await fresh.request('/api/campaigns', { headers: { Cookie: cookie } })).status, 401);
  const capped = await fixture(t, { maxRecords: 6 });
  for (let i = 0; i < 6; i++) await capped.login();
  const tx = await capped.start();
  assert.equal((await capped.request(`/api/auth/callback?code=${'c'.repeat(43)}&state=${tx.state}`, { headers: { Cookie: tx.cookie } })).status, 503);
});

test('minimal three-variable setup derives secure defaults', () => {
  const env = { APP_PUBLIC_URL: 'https://landing.test', CMS_PUBLIC_URL: 'https://cms.test', SSO_CLIENT_SECRET: 's'.repeat(40) };
  const result = readAuthConfig(env, { inDocker: false });
  assert.equal(result.api, 'https://cms.test/api');
  assert.equal(result.clientId, 'landing-page');
  assert.equal(result.secure, true);
  assert.equal(result.previewHost, '127.0.0.1');
  assert.deepEqual([result.transactionTtl, result.sessionTtl, result.idleTtl, result.roleTtl], [300000, 28800000, 1800000, 60000]);
});

test('minimal local setup works natively and in Docker without weakening public HTTPS', () => {
  const env = { APP_PUBLIC_URL: 'http://localhost:5183', CMS_PUBLIC_URL: 'http://localhost:8102', SSO_CLIENT_SECRET: 's'.repeat(40) };
  assert.equal(readAuthConfig(env, { inDocker: false }).api, 'http://localhost:8102/api');
  assert.equal(readAuthConfig(env, { inDocker: true }).api, 'http://host.docker.internal:8102/api');
  assert.equal(readAuthConfig(env, { inDocker: true }).previewHost, '127.0.0.1');
  assert.equal(readAuthConfig({ ...env, APP_PUBLIC_URL: 'http://127.0.0.1:5183' }).previewHost, 'localhost');
  assert.throws(() => readAuthConfig({ ...env, NODE_ENV: 'production' }));
  assert.throws(() => readAuthConfig({ ...env, CMS_PUBLIC_URL: 'http://cms.example.com' }));
  assert.throws(() => readAuthConfig({ ...env, CMS_API_BASE_URL: 'http://evil.test' }));
});

test('advanced API overrides remain explicit and are not rewritten', () => {
  const env = { APP_PUBLIC_URL: 'https://landing.test', CMS_PUBLIC_URL: 'https://cms.test', SSO_CLIENT_SECRET: 's'.repeat(40), CMS_API_BASE_URL: 'https://internal.test/custom' };
  assert.equal(readAuthConfig(env, { inDocker: true }).api, 'https://internal.test/custom');
});

test('signing out of CMS ends the landing session; tab focus re-checks at once', async t => {
  const f = await fixture(t); const { cookie } = await f.login(); const headers = { Cookie: cookie };
  f.role('signedout');
  // Within the role cache window a plain request is still served from cache...
  assert.equal((await f.request('/api/auth/me', { headers })).status, 200);
  assert.equal(f.roleChecks(), 0);
  // ...but a focus re-check (older than 5s) asks CMS and drops the revoked session.
  f.advance(5001);
  assert.equal((await f.request('/api/auth/me?fresh=1', { headers })).status, 401);
  f.role('admin');
  assert.equal((await f.request('/api/campaigns', { headers })).status, 401);
  // Background checks also revoke once the cache expires.
  const second = await f.login(); f.role('signedout'); f.advance(60001);
  assert.equal((await f.request('/api/campaigns', { headers: { Cookie: second.cookie } })).status, 401);
});

test('focus re-checks are throttled', async t => {
  const f = await fixture(t); const { cookie } = await f.login();
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/api/auth/me?fresh=1', { headers: { Cookie: cookie } })).status, 200);
  assert.equal(f.roleChecks(), 0);
  f.advance(5001);
  assert.equal((await f.request('/api/auth/me?fresh=1', { headers: { Cookie: cookie } })).status, 200);
  assert.equal(f.roleChecks(), 1);
});
