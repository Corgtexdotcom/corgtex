import { createServer } from "node:https";
import { request } from "node:http";
import { readFileSync } from "node:fs";

if (process.env.SELFSERVE_ISOLATED_FIXTURE !== "true") throw new Error("ISOLATED_FIXTURE_REQUIRED");
createServer({ key: readFileSync("/fixture-tls/key.pem"), cert: readFileSync("/fixture-tls/cert.pem") }, (incoming, outgoing) => {
  const upstream = request({ hostname: "fixture-app", port: 3000, path: incoming.url, method: incoming.method,
    headers: { ...incoming.headers, "x-forwarded-proto": "https", "x-forwarded-host": incoming.headers.host } }, (response) => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  upstream.on("error", () => { outgoing.writeHead(502); outgoing.end("Synthetic upstream unavailable"); });
  incoming.pipe(upstream);
}).listen(3443, "0.0.0.0");
