import http from "node:http";
import { getFreePort } from "../verify/ephemeral-server.mjs";

/* A tiny reverse proxy that sits in front of a running preview server and
 * strips the response headers that stop a browser from rendering it inside
 * an <iframe>.
 *
 * Why this exists: the review UI's whole job is to show a human the page the
 * pipeline just generated, and the honest way to do that is to embed the real
 * running page rather than re-render an approximation of it. But the target
 * repo (atss-frontend) sends `X-Frame-Options: DENY` on every route from its
 * next.config.mjs securityHeaders block, so a direct iframe of the preview
 * URL renders as a blank box in every browser. That header is correct for
 * production and we are not going to patch the repo to work around our own
 * tooling — so the proxy removes it on the way out instead.
 *
 * Why a whole separate PORT rather than a path prefix on the main API server:
 * a Next.js page's HTML references its assets with root-absolute URLs
 * (`/_next/static/...`, `/favicon.ico`). Served under a prefix like
 * `/preview/abc/`, every one of those would resolve against the API server's
 * root and 404. Giving the proxy its own origin means those paths keep
 * working untouched, with no HTML rewriting and nothing to keep in sync with
 * whatever Next emits next.
 *
 * Scope: bound to 127.0.0.1 only, and each instance can talk to exactly one
 * fixed upstream — it is not a general-purpose forwarder, and there is no way
 * to steer it at another host by crafting a request. */

// Removed from every proxied response. The frame-blocking pair — one legacy
// header, one modern CSP directive — plus CSP's report-only twin, which does
// not block but does spam the console with violations for the frame we just
// deliberately allowed.
const STRIPPED_RESPONSE_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
]);

/**
 * @param {object} p
 * @param {string} p.targetBaseUrl - origin of the already-running preview server, e.g. "http://127.0.0.1:41234"
 * @returns {Promise<{port: number, baseUrl: string, close: () => Promise<void>}>}
 */
export async function startFrameableProxy({ targetBaseUrl }) {
  const target = new URL(targetBaseUrl);
  const port = await getFreePort();

  const server = http.createServer((req, res) => {
    // Everything about the upstream request is fixed except the path: host,
    // port and protocol come from targetBaseUrl, never from the incoming
    // request, so a request for `http://evil/` can't be forwarded anywhere.
    const upstream = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          // The upstream is addressed by its own host:port — passing the
          // proxy's Host through makes Next generate self-links pointing at
          // the proxy, which then loop back through here forever.
          host: target.host,
          // No compression: nothing here inspects or rewrites the body, and
          // asking for identity means the upstream's Content-Length stays
          // meaningful all the way through.
          "accept-encoding": "identity",
        },
      },
      (upstreamRes) => {
        const headers = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (STRIPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
          headers[name] = value;
        }
        // A redirect to an absolute upstream URL would bounce the iframe out
        // of the proxy origin and straight back into X-Frame-Options: DENY.
        if (typeof headers.location === "string" && headers.location.startsWith(target.origin)) {
          headers.location = headers.location.slice(target.origin.length) || "/";
        }
        res.writeHead(upstreamRes.statusCode ?? 502, headers);
        upstreamRes.pipe(res);
      }
    );

    // The upstream is a dev/preview server that can be killed out from under
    // us at any moment (idle sweep, explicit stop, run cleanup). Answer with
    // something readable instead of hanging the iframe until it times out.
    upstream.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Preview server is not responding at ${target.origin}\n${err.message}\n`);
    });

    req.pipe(upstream);
  });

  // Next.js in production (`next start`) needs no websocket; `next dev`'s HMR
  // socket would. Not proxied on purpose — a preview is a snapshot of a built
  // page, and a failed HMR connection degrades to "no live reload" rather
  // than to a broken page.
  server.on("clientError", (_err, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
