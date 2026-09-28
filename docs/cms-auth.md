# CMS-linked login

No database tables, columns, migrations, or permission rows are added. CMS authenticates the existing Supabase account and reads `app_users.role` by the verified user ID. `admin`, `marketing`, and `intern` can use the entire campaign workspace. Missing membership and unknown roles are denied. Editing roles among these three does not remove access; remove membership or choose a disallowed role to revoke access. Rechecks do not detect changes reverted between checks.

The CMS browser retains its Supabase tokens. A browser-bound S256 PKCE exchange passes only a 60-second, single-use code to landing. Landing uses an opaque HttpOnly session cookie, not a browser-stored token or API key. CMS logout and landing logout are independent. Landing logout must not automatically restart login.

## Minimal configuration

Only **three login settings per project** are needed. The existing local `.env` files
already contain matching values; the secret was preserved, not regenerated.

CMS `.env`:

```dotenv
CMS_PUBLIC_URL=https://cms.example.com
LANDING_PAGE_URL=https://landing.example.com
LANDING_PAGE_SECRET=<shared random secret>
```

Landing `.env`:

```dotenv
APP_PUBLIC_URL=https://landing.example.com
CMS_PUBLIC_URL=https://cms.example.com
SSO_CLIENT_SECRET=<same value as CMS LANDING_PAGE_SECRET>
```

Use your actual public origins (no paths). The secret must be a random URL-safe
32–256 character value, kept server-only. The two existing CMS app integrations
keep their own settings and are unchanged. These login settings are separate
from the existing AI/GitHub/Supabase configuration.

Everything else has a default:

- Landing client ID: `landing-page`; allowed roles: `admin`, `marketing`, `intern`.
- Callback: landing origin + `/api/auth/callback`.
- CMS API: CMS origin + `/api`; the UI proxies it to the backend.
- Login code: 60 seconds; login transaction: 5 minutes; session: 8 hours maximum;
  inactivity: 30 minutes; role recheck: within 60 seconds.
- Development accepts HTTP **only on loopback hostnames**. `NODE_ENV=production`
  rejects HTTP even on loopback. Public/non-loopback origins always require HTTPS.
- In the supplied Docker Compose setup, a derived CMS localhost API address is
  translated to `host.docker.internal` automatically. The public redirect URL
  still uses the configured CMS origin. Container-internal proxy targets are
  supplied by Compose and do not need `.env` entries.
- Local preview hostname: `127.0.0.1`, or `localhost` when the application itself
  uses `127.0.0.1`, so cookies are not shared with generated previews.

Never commit `.env`, copy secrets into frontend bundles, or put them in `VITE_*`
variables. Browser requests use relative `/api`; keep CMS `VITE_BACKEND_URL` empty.
The site URLs are configuration, not hardcoded in the application.

### Optional overrides — only for unusual deployments

You do **not** need to copy these into `.env`:

| Variable | When needed |
|---|---|
| Landing `CMS_API_BASE_URL` | CMS API is reachable at a different server-only address. Use a base including `/api` for CMS nginx, or omit `/api` for direct FastAPI. Explicit overrides are never rewritten. |
| `API_PROXY_TARGET` | Local development backend does not use the normal port (landing: `PORT` or 4300; CMS: `CMS_API_PORT` or 8100). |
| `DOCKER_API_PROXY_TARGET` | Using a custom UI proxy target instead of the supplied Compose backend service. |
| Landing `PREVIEW_PUBLIC_HOST` | Using a dedicated production preview gateway. This does not provision the gateway. |
| Landing `SSO_ALLOW_INTERNAL_HTTP=true` | An explicit API override uses HTTP on a trusted private network. Never use it for internet traffic. |
| CMS `SSO_CLIENTS_JSON` | Registering additional compatible clients or customizing roles; the existing JSON registry remains supported. Do not also register `landing-page` in JSON while using `LANDING_PAGE_URL`. |
| CMS `SSO_ALLOW_LEGACY_AUTH=true` | A verified legacy symmetric Supabase project has an empty JWKS. The inspected project has an asymmetric key, so no setting is needed. |

Existing timeout overrides remain supported with the same secure upper bounds,
but defaults are sufficient. No `SSO_CLIENT_ID`, callback URL, timeout, insecure
localhost flag, or separate Docker CMS address is required for the normal setup.
For a custom Compose publish port, `UI_PORT` remains an ordinary optional hosting
setting (default 5183); keep `APP_PUBLIC_URL` aligned with the browser-facing URL.

## Local setup

The local environment is configured using the CMS's existing Compose ports: CMS UI `http://localhost:8102`, CMS backend `http://localhost:8100`. Landing UI is `http://localhost:5183`, backend `http://localhost:4300`. Port 5173 was already occupied by an unrelated app, which was left running. Previews use `127.0.0.1`, keeping their hostname separate from the authenticated UI's `localhost`.

1. Start CMS using its existing Compose workflow, or run its backend on 8100 and `npm run dev` inside its frontend. Vite derives its UI port from `CMS_PUBLIC_URL` and proxies to backend port 8100 by default.
2. From landing `new_approach`, run `npm ci` and `npm start`.
3. From landing `new_approach/ui`, run `npm ci` and `npm run dev`. Vite uses the parent `.env` and refuses to silently switch ports.
4. Open the landing URL or CMS's new Landing Page link. Sign in normally through CMS. Deep links return to their original local page.

Both services require a single backend worker/instance. Codes, rate limits, and sessions live in bounded memory and are intentionally lost on restart. No API-key fallback remains. Multiple instances require a shared temporary store such as Redis and coordinated code consumption; sticky routing is insufficient. Existing campaign jobs continue independently of browser sessions.

## Production checks

Configure the three settings above with HTTPS public origins. The exact callback is derived automatically. Use a separate production preview gateway/hostname for remote previews. Keep backend/preview ports private. The existing dynamic loopback previews need a separate TLS gateway for remote production use; never expose raw preview ports or serve generated HTML on the authenticated app origin. Node-based host previews preload a loopback-only listener guard; Next/Vite also receive explicit host flags. Container previews publish to loopback only. Preview proxies remove Cookie/Authorization/X-CSRF-Token requests and Set-Cookie responses. SSO secrets are removed from spawned process environments, but host-based generated builds are not a security sandbox: use isolated containers and filesystem permissions for untrusted generated code.

Run this read-only SQL in the Supabase SQL editor before production:

```sql
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'app_users';

SELECT relrowsecurity, relforcerowsecurity
FROM pg_class
WHERE oid = 'public.app_users'::regclass;

SELECT grantee, privilege_type
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name = 'app_users';
```

Verify ordinary `anon`/`authenticated` clients cannot insert or update their own privileged role, directly or through a SECURITY DEFINER function. A policy permitting users to update their own entire row is insufficient. Restrict role changes to trusted server/admin operations. The configured PostgREST API returned 404 for the policy catalog, and no database SQL credentials were provided; existing live policies have **not** been certified or modified.

Authentication endpoints return `no-store`; landing nginx suppresses callback query logging. Apply the same query/credential redaction in outer reverse proxies/APM. Application mutation logs include user ID, path, method and status; no credentials or payloads. Configure and monitor authentication 401/403/429/503 responses without recording tokens. Rate limits use the socket peer address, not untrusted forwarded headers; behind nginx users share that budget. Tune deliberately if needed rather than blindly trusting X-Forwarded-For.

## Endpoints and checks

CMS API: `GET /auth/sso/clients`, `POST /auth/sso/authorize`, `POST /auth/sso/exchange`, `POST /auth/sso/role`. Only public labels/launch URLs are returned by the clients endpoint; service endpoints require the per-client secret. Existing Shock and Awe/LeadOSINT contracts remain separate and unchanged.

Landing public proxy: `GET /api/auth/start`, `GET /api/auth/callback`, `GET /api/auth/me`, `POST /api/auth/activity`, `POST /api/auth/logout`. The proxy strips `/api` before forwarding. All `/campaigns` routes are guarded centrally. Mutations require both the session CSRF token and exact application Origin. Passive reads/streams do not extend idle expiry; real UI activity does.

Run `node --test test/session-auth.test.mjs test/frameable-proxy.test.mjs test/spawn-env.test.mjs` in landing and `python -m pytest tests/test_sso.py tests/test_handoff.py -q` in CMS. Build both frontends. Before switching production traffic, verify a real account login, deep link, unauthorized account, logout, role removal, backend restart, and CMS outage.
