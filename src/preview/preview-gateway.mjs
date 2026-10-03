import http from "node:http";
import { randomBytes } from "node:crypto";

/* One public port in front of every running preview, routed by hostname.
 *
 * Why this exists: each preview (and its frameable proxy) listens on a random
 * loopback port, which only works when the browser runs on the same machine
 * as this service. On a remote host the review UI would hand the browser
 * `http://127.0.0.1:<port>` — the reviewer's own laptop. Opening a firewall
 * hole per random port isn't workable, so this gateway is the single public
 * entry point.
 *
 * Why route by hostname rather than path: a Next.js page references its
 * assets root-absolutely (`/_next/static/...`), so a path prefix would break
 * them — the same reason the frameable proxy gets its own origin. Each
 * preview instead gets `<token>.<domain>`, e.g.
 * `3f9c….84-46-241-116.sslip.io:5190`, which wildcard DNS resolves to this
 * host. That also keeps generated code on a different origin from the
 * authenticated app.
 *
 * The token is 128 random bits, so a running preview can't be found by
 * guessing, and it stops resolving as soon as the preview is stopped.
 * Upstreams are always 127.0.0.1 ports registered by preview-server.mjs —
 * nothing about an incoming request can steer the gateway anywhere else. */

const routes = new Map(); // token -> loopback port of that preview's frameable proxy
let gateway = null; // { server, port, domain }

function tokenFromHost(hostHeader, domain) {
  if (typeof hostHeader !== "string") return null;
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const token = host.slice(0, -suffix.length);
  return /^[a-f0-9]{32}$/.test(token) ? token : null;
}

/**
 * @param {object} p
 * @param {number} p.port - public port; 0 picks a free one (tests)
 * @param {string} [p.host] - interface to bind
 * @param {string} p.domain - wildcard-DNS domain the preview hostnames hang off, e.g. "84-46-241-116.sslip.io"
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startPreviewGateway({ port, host = "0.0.0.0", domain }) {
  if (gateway) throw new Error("preview gateway already running");
  domain = String(domain || "").toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(domain)) throw new Error("preview gateway needs a domain (PREVIEW_PUBLIC_HOST)");

  const server = http.createServer((req, res) => {
    const token = tokenFromHost(req.headers.host, domain);
    const target = token && routes.get(token);
    if (!target) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("No preview here — it may have expired or been stopped. Restart it from the run page.\n");
      return;
    }

    const upstream = http.request(
      { host: "127.0.0.1", port: target, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${target}` } },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      }
    );
    upstream.on("error", (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end(`Preview is not responding\n${err.message}\n`);
    });
    req.pipe(upstream);
  });
  server.on("clientError", (_err, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  gateway = { server, port: server.address().port, domain };
  return {
    port: gateway.port,
    close: () =>
      new Promise((resolve) => {
        routes.clear();
        gateway = null;
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Registers a loopback port and returns its public URL, or null when no gateway is running. */
export function addGatewayRoute(targetPort) {
  if (!gateway) return null;
  const token = randomBytes(16).toString("hex");
  routes.set(token, targetPort);
  return { token, baseUrl: `http://${token}.${gateway.domain}:${gateway.port}` };
}

export function removeGatewayRoute(token) {
  if (token) routes.delete(token);
}
