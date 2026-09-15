import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import pg from "pg";
import { POSTGRES_CLIENT_IMAGE } from "./run-postgres-restore-rehearsal.mjs";
import { SOURCE_IMAGE, SOURCE_PINS, verifyBundle, pinnedBytes, check, ATTEST_SQL, assertRuntime, collectCorpus, compareCorpus } from "./synthetic-ops-source.mjs";
import { localToolEnvironment } from "./synthetic-subprocess.mjs";

export const LABEL = "corgtex.synthetic.ops";
export const save = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" });
export async function relay(bind, host, port) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    const upstream = net.connect({ host, port });
    sockets.add(socket); sockets.add(upstream);
    socket.pipe(upstream); upstream.pipe(socket);
    for (const s of [socket, upstream]) {
      s.on("error", () => { socket.destroy(); upstream.destroy(); });
      s.on("close", () => { sockets.delete(s); socket.destroy(); upstream.destroy(); });
    }
  });
  await new Promise((yes, no) => { server.once("error", no); server.listen(0, bind, yes); });
  return { port: server.address().port, close: () => new Promise(done => { for (const s of sockets) s.destroy(); server.close(done); }) };
}
export async function withDatabase(config, run) {
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  const timer = setTimeout(() => client.connection?.stream?.destroy(), 60000);
  try { await client.connect(); return await run(client); }
  finally { try { await client.end(); } finally { clearTimeout(timer); } }
}
export function dockerTools(supervisor, deadline, env = process.env) {
  return args => supervisor.run("docker", args, { deadline, env: localToolEnvironment(env), maxBytes: 4 * 1024 * 1024 });
}
export async function inspectSource(docker, owned) {
  check(/^[a-f0-9-]{36}$/u.test(owned.id) && owned.network === `syn-ops-${owned.id}` && owned.container === `syn-source-${owned.id}`, "FIXTURE_IDENTITY_INVALID");
  const [network] = JSON.parse(await docker(["network", "inspect", owned.network]));
  const [container] = JSON.parse(await docker(["inspect", owned.container]));
  check(network.Internal === true && network.EnableIPv6 === false && network.Labels?.[LABEL] === owned.id
    && container.Config.Labels?.[LABEL] === owned.id && container.Image === SOURCE_IMAGE
    && Object.keys(container.NetworkSettings.Networks).join() === owned.network
    && Object.keys(container.HostConfig.PortBindings ?? {}).length === 0, "FIXTURE_NETWORK_OR_OWNER_DRIFT");
  const address = container.NetworkSettings.Networks[owned.network].IPAddress;
  const gateway = network.IPAM.Config[0].Gateway;
  check(net.isIPv4(address) && net.isIPv4(gateway), "FIXTURE_NETWORK_ADDRESS_INVALID");
  return { address, gateway };
}
export async function bootstrapSource({ bundle, directory, evidenceDirectory, supervisor, deadline }) {
  check(process.platform === "linux" && process.arch === "arm64", "SOURCE_BOOTSTRAP_REQUIRES_LINUX_ARM64");
  verifyBundle(bundle);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const docker = dockerTools(supervisor, deadline);
  // The tar is pinned before loading. Runtime tools never pull an image.
  await docker(["load", "--input", resolve(bundle, "source-image.tar")]);
  const [image] = JSON.parse(await docker(["image", "inspect", SOURCE_IMAGE]));
  check(image.Id === SOURCE_IMAGE && image.Architecture === "arm64" && image.Os === "linux", "SOURCE_IMAGE_MISMATCH");
  await docker(["image", "inspect", POSTGRES_CLIENT_IMAGE]);
  const id = randomUUID(), owned = { id, network: `syn-ops-${id}`, container: `syn-source-${id}` };
  save(`${directory}/local-owner.json`, owned);
  save(`${evidenceDirectory}/local-owner.json`, owned);
  const tls = resolve(directory, "tls"); mkdirSync(tls, { mode: 0o700 });
  const tool = (args) => supervisor.run("openssl", args, { deadline, env: localToolEnvironment() });
  await tool(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${tls}/ca.key`, "-out", `${tls}/ca.crt`, "-days", "2", "-subj", "/CN=Synthetic Ops CA"]);
  await tool(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", `${tls}/server.key`, "-out", `${tls}/server.csr`, "-subj", "/CN=localhost"]);
  writeFileSync(`${tls}/server.ext`, "subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n", { mode: 0o600, flag: "wx" });
  await tool(["x509", "-req", "-in", `${tls}/server.csr`, "-CA", `${tls}/ca.crt`, "-CAkey", `${tls}/ca.key`, "-CAcreateserial", "-out", `${tls}/server.crt`, "-days", "2", "-extfile", `${tls}/server.ext`]);
  chmodSync(`${tls}/server.key`, 0o644);
  await docker(["network", "create", "--internal", "--label", `${LABEL}=${id}`, owned.network]);
  await docker(["run", "--pull=never", "-d", "--name", owned.container, "--label", `${LABEL}=${id}`, "--network", owned.network,
    "--memory", "1g", "--cpus", "1", "--mount", "type=tmpfs,destination=/var/lib/postgresql",
    "--mount", `type=bind,source=${tls},target=/tls,readonly`,
    "--mount", `type=bind,source=${resolve(bundle, "synthetic.dump")},target=/synthetic.dump,readonly`,
    "-e", "POSTGRES_PASSWORD=synthetic-local-only", "-e", "POSTGRES_INITDB_ARGS=--locale=en_US.utf8 --encoding=UTF8",
    "--entrypoint", "sh", SOURCE_IMAGE, "-c",
    "cp /tls/server.crt /tmp/server.crt && cp /tls/server.key /tmp/server.key && chown postgres:postgres /tmp/server.* && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key"]);
  const { address } = await inspectSource(docker, owned);
  const bridge = await relay("127.0.0.1", address, 5432);
  const ca = readFileSync(`${tls}/ca.crt`, "utf8");
  const config = { host: "127.0.0.1", port: bridge.port, user: "postgres", password: "synthetic-local-only", database: "postgres", ssl: { ca, rejectUnauthorized: true } };
  try {
    let ready = false;
    const startupDeadline = Math.min(deadline, Date.now() + 60000);
    while (Date.now() < startupDeadline && !ready) {
      const logs = await docker(["logs", owned.container]);
      if (logs.includes("PostgreSQL init process complete")) {
        try { await withDatabase(config, c => c.query("SELECT 1")); ready = true; }
        catch (e) { if (!["ECONNREFUSED", "57P03"].includes(e.code)) throw e; }
      }
      if (!ready) await new Promise(r => setTimeout(r, 500));
    }
    check(ready, "SOURCE_STARTUP_UNPROVEN");
    await withDatabase(config, c => c.query("CREATE DATABASE source TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'"));
    await docker(["exec", owned.container, "pg_restore", "--exit-on-error", "--no-owner", "--no-acl", "-U", "postgres", "-d", "source", "/synthetic.dump"]);
    await withDatabase({ ...config, database: "source" }, async c => {
      assertRuntime((await c.query(ATTEST_SQL)).rows[0], "2.41");
      await c.query("CREATE ROLE fixture_reader LOGIN PASSWORD 'synthetic-local-only' NOSUPERUSER; ALTER ROLE fixture_reader SET default_transaction_read_only=on; GRANT CONNECT ON DATABASE source TO fixture_reader; GRANT USAGE ON SCHEMA public TO fixture_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO fixture_reader; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO fixture_reader");
      for (const { oid } of (await c.query("SELECT oid FROM pg_largeobject_metadata")).rows) {
        check(Number.isSafeInteger(oid) && oid > 0, "SYNTHETIC_LO_ID_INVALID");
        await c.query(`GRANT SELECT ON LARGE OBJECT ${oid} TO fixture_reader`);
      }
    });
    await withDatabase(config, c => c.query("CREATE DATABASE corpus TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'en_US.utf8' LC_CTYPE 'en_US.utf8'"));
    const baseline = JSON.parse(pinnedBytes(bundle, "source-baseline.json")).probe.baseline;
    const captured = await withDatabase({ ...config, database: "corpus" }, async c => {
      await c.query(pinnedBytes(bundle, "corpus.sql").toString());
      assertRuntime((await c.query(ATTEST_SQL)).rows[0], "2.41");
      return collectCorpus(c);
    });
    const comparison = compareCorpus(captured, baseline);
    check(comparison.observationsEqual && comparison.indexesValid, "SOURCE_BASELINE_DIVERGED");
    const routes = await docker(["exec", owned.container, "cat", "/proc/net/route"]);
    check(!routes.split("\n").slice(1).some(row => row.trim().split(/\s+/u)[1] === "00000000"), "SOURCE_DEFAULT_ROUTE_PRESENT");
    const receipt = { status: "SYNTHETIC_SOURCE_PREPARED", owned, pins: SOURCE_PINS,
      runtime: "PG18.6/en_US.utf8/libc2.41/vector0.8.2/linux-arm64", sourceCorpus: captured, comparison,
      tlsVerified: true, disconnected: true, noDefaultRoute: true, productionAccepted: false };
    save(`${directory}/source-ready.json`, receipt);
    return receipt;
  } finally { await bridge.close(); }
}
export async function cleanupLocal(docker, owned) {
  check(/^[a-f0-9-]{36}$/u.test(owned.id), "FIXTURE_IDENTITY_INVALID");
  const ids = (await docker(["ps", "-aq", "--filter", `label=${LABEL}=${owned.id}`])).split(/\s+/u).filter(Boolean);
  for (const id of ids) {
    const [container] = JSON.parse(await docker(["inspect", id]));
    check(container.Config.Labels?.[LABEL] === owned.id, "FIXTURE_CLEANUP_OWNER_MISMATCH");
    await docker(["rm", "-f", "-v", id]);
  }
  const networks = JSON.parse(await docker(["network", "ls", "--filter", `label=${LABEL}=${owned.id}`, "--format", "json"])
    .then(s => `[${s.split("\n").filter(Boolean).join(",")}]`));
  for (const n of networks) {
    const [network] = JSON.parse(await docker(["network", "inspect", n.ID]));
    check(network.Labels?.[LABEL] === owned.id && network.Name === owned.network && Object.keys(network.Containers ?? {}).length === 0, "FIXTURE_CLEANUP_OWNER_MISMATCH");
    await docker(["network", "rm", n.ID]);
  }
  check(!(await docker(["ps", "-aq", "--filter", `label=${LABEL}=${owned.id}`])), "FIXTURE_CLEANUP_UNPROVEN");
  check(!(await docker(["network", "ls", "--filter", `label=${LABEL}=${owned.id}`, "--format", "{{.ID}}"])), "FIXTURE_CLEANUP_UNPROVEN");
}
