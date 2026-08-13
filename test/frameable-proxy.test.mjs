import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { startFrameableProxy } from "../src/preview/frameable-proxy.mjs";

/* No mocking: every test here runs a real upstream HTTP server, a real proxy
 * in front of it, and real fetch() calls through the proxy — the same shape as
 * the preview path in production, just with a 20-line server standing in for
 * Next.js. */

/** Starts a throwaway upstream and returns its origin plus a stop(). */
async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

test("strips the headers that stop a browser from framing the page", async () => {
  // Exactly what atss-frontend's next.config.mjs securityHeaders sends.
  const upstream = await startUpstream((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    res.end("<h1>generated landing page</h1>");
  });
  const proxy = await startFrameableProxy({ targetBaseUrl: upstream.origin });

  try {
    const res = await fetch(`${proxy.baseUrl}/campaigns/spring-sale`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-frame-options"), null);
    assert.equal(res.headers.get("content-security-policy"), null);
    // Only the frame-blocking ones go — everything else is passed through
    // untouched, so the page renders exactly as the upstream serves it.
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await res.text(), "<h1>generated landing page</h1>");
  } finally {
    await proxy.close();
    await upstream.stop();
  }
});

test("forwards the path and query string verbatim", async () => {
  // Root-absolute asset URLs (/_next/static/...) are the reason the proxy gets
  // its own origin rather than a path prefix — they have to arrive unchanged.
  const seen = [];
  const upstream = await startUpstream((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("asset");
  });
  const proxy = await startFrameableProxy({ targetBaseUrl: upstream.origin });

  try {
    await fetch(`${proxy.baseUrl}/_next/static/chunks/main.js?v=abc123`);
    assert.deepEqual(seen, ["/_next/static/chunks/main.js?v=abc123"]);
  } finally {
    await proxy.close();
    await upstream.stop();
  }
});

test("forwards the request method and body", async () => {
  // The previewed page's lead form POSTs from inside the iframe.
  let received = null;
  const upstream = await startUpstream((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received = { method: req.method, body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  const proxy = await startFrameableProxy({ targetBaseUrl: upstream.origin });

  try {
    const res = await fetch(`${proxy.baseUrl}/api/lead`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"email":"a@b.com"}',
    });

    assert.equal(res.status, 200);
    assert.deepEqual(received, { method: "POST", body: '{"email":"a@b.com"}' });
  } finally {
    await proxy.close();
    await upstream.stop();
  }
});

test("rewrites an absolute redirect back onto the proxy origin", async () => {
  // A Location pointing at the upstream would bounce the iframe off the proxy
  // origin and straight back into the X-Frame-Options the proxy exists to strip.
  const upstream = await startUpstream((req, res) => {
    if (req.url === "/old") {
      res.writeHead(308, { location: `${upstream.origin}/new` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("landed");
  });
  const proxy = await startFrameableProxy({ targetBaseUrl: upstream.origin });

  try {
    const res = await fetch(`${proxy.baseUrl}/old`, { redirect: "manual" });
    assert.equal(res.headers.get("location"), "/new");

    // And following it really does stay on the proxy.
    const followed = await fetch(`${proxy.baseUrl}/old`);
    assert.equal(new URL(followed.url).port, String(proxy.port));
    assert.equal(await followed.text(), "landed");
  } finally {
    await proxy.close();
    await upstream.stop();
  }
});

test("answers 502 with a readable message when the preview server is gone", async () => {
  // The upstream is killed by the idle sweep, an explicit stop, or a service
  // restart — the iframe should say so rather than hang until it times out.
  const upstream = await startUpstream((_req, res) => res.end("alive"));
  const proxy = await startFrameableProxy({ targetBaseUrl: upstream.origin });
  await upstream.stop();

  try {
    const res = await fetch(`${proxy.baseUrl}/campaigns/spring-sale`);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /Preview server is not responding/);
  } finally {
    await proxy.close();
  }
});

test("only ever talks to its configured upstream", async () => {
  // The proxy is bound to one origin at construction time. An absolute-form
  // request URI (legal in HTTP/1.1, and what a client would send to a real
  // forward proxy) must not steer it somewhere else.
  const intended = await startUpstream((_req, res) => res.end("intended upstream"));
  const other = await startUpstream((_req, res) => res.end("SHOULD NOT BE REACHED"));
  const proxy = await startFrameableProxy({ targetBaseUrl: intended.origin });

  try {
    const res = await fetch(`${proxy.baseUrl}/`, { headers: { host: new URL(other.origin).host } });
    assert.equal(await res.text(), "intended upstream");
  } finally {
    await proxy.close();
    await intended.stop();
    await other.stop();
  }
});
