import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { startPreviewGateway, addGatewayRoute, removeGatewayRoute } from "../src/preview/preview-gateway.mjs";

/* Real gateway, real upstream, real HTTP — the only fake is the Host header,
 * standing in for the wildcard DNS name a browser would have resolved. */

const DOMAIN = "84-46-241-116.sslip.io";

async function startUpstream(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** GET through the gateway with an explicit Host header (fetch won't let us set one). */
function get(gatewayPort, host, path = "/") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: gatewayPort, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("addGatewayRoute returns null when no gateway is running", () => {
  assert.equal(addGatewayRoute(12345), null);
});

test("routes a preview hostname to its upstream, preserving path and query", async () => {
  const upstream = await startUpstream((req, res) => res.end(`saw ${req.url}`));
  const gateway = await startPreviewGateway({ port: 0, host: "127.0.0.1", domain: DOMAIN });
  try {
    const route = addGatewayRoute(upstream.port);
    assert.match(route.baseUrl, new RegExp(`^http://[a-f0-9]{32}\\.${DOMAIN.replace(/\./g, "\\.")}:${gateway.port}$`));

    const host = new URL(route.baseUrl).host;
    const res = await get(gateway.port, host, "/_next/static/chunk.js?v=1");
    assert.equal(res.status, 200);
    assert.equal(res.body, "saw /_next/static/chunk.js?v=1");

    // Hostnames are case-insensitive; a browser may send them uppercased.
    assert.equal((await get(gateway.port, host.toUpperCase(), "/x")).body, "saw /x");
  } finally {
    await gateway.close();
    await upstream.stop();
  }
});

test("unknown, malformed and removed hostnames get a 404, never an upstream", async () => {
  let hits = 0;
  const upstream = await startUpstream((_req, res) => {
    hits++;
    res.end("ok");
  });
  const gateway = await startPreviewGateway({ port: 0, host: "127.0.0.1", domain: DOMAIN });
  try {
    const route = addGatewayRoute(upstream.port);
    const host = new URL(route.baseUrl).host;
    const token = host.split(".")[0];

    assert.equal((await get(gateway.port, `${"0".repeat(32)}.${DOMAIN}`)).status, 404);
    assert.equal((await get(gateway.port, `${token}.evil.test`)).status, 404);
    assert.equal((await get(gateway.port, DOMAIN)).status, 404);
    assert.equal((await get(gateway.port, "84.46.241.116:5190")).status, 404);

    removeGatewayRoute(route.token);
    assert.equal((await get(gateway.port, host)).status, 404);
    assert.equal(hits, 0);
  } finally {
    await gateway.close();
    await upstream.stop();
  }
});

test("answers 502 when the preview behind a route has died", async () => {
  const upstream = await startUpstream((_req, res) => res.end("ok"));
  const gateway = await startPreviewGateway({ port: 0, host: "127.0.0.1", domain: DOMAIN });
  try {
    const route = addGatewayRoute(upstream.port);
    await upstream.stop();
    assert.equal((await get(gateway.port, new URL(route.baseUrl).host)).status, 502);
  } finally {
    await gateway.close();
  }
});
