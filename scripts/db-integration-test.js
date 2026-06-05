import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const port = Number(process.env.DATAIO_TEST_PORT ?? 3320);
const baseUrl = `http://127.0.0.1:${port}`;

async function parseConnections() {
  if (process.env.DATAIO_TEST_CONNECTIONS) {
    const parsed = JSON.parse(process.env.DATAIO_TEST_CONNECTIONS);
    if (!Array.isArray(parsed)) throw new Error("DATAIO_TEST_CONNECTIONS must be a JSON array");
    return parsed;
  }
  if (process.env.DATAIO_TEST_USE_CATALOG === "1") {
    const catalogPath = process.env.DATAIO_CATALOG_PATH ?? path.join(process.cwd(), "data", "catalog.json");
    const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
    return (catalog.connections ?? []).map((connection) => ({
      ...connection,
      expectedTable: connection.expectedTable ?? process.env.DATAIO_TEST_EXPECTED_TABLE ?? "sale_order"
    }));
  }
  return [];
}

function expectedTableName(connection) {
  return (connection.expectedTable ?? "sale_order").toLowerCase();
}

function quoteIdentifier(value, type) {
  if (type === "mysql") return `\`${String(value).replaceAll("`", "``")}\``;
  if (type === "sqlserver") return `[${String(value).replaceAll("]", "]]")}]`;
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableReference(table, type) {
  if (type === "mysql") return quoteIdentifier(table.table, type);
  return `${quoteIdentifier(table.schema, type)}.${quoteIdentifier(table.table, type)}`;
}

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname} failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForServer(server) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const body = await request("/api/health");
      if (body.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Server did not start. exitCode=${server.exitCode}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const connections = await parseConnections();
if (!connections.length) {
  console.log("db integration test skipped: set DATAIO_TEST_CONNECTIONS or DATAIO_TEST_USE_CATALOG=1");
  process.exit(0);
}

const tempDir = await mkdtemp(path.join(tmpdir(), "dataio-db-test-"));
const storePath = path.join(tempDir, "catalog.json");
const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(port), DATAIO_STORE_PATH: storePath },
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForServer(server);
  for (const connectionInput of connections) {
    const connection = await request("/api/connections", {
      method: "POST",
      body: JSON.stringify(connectionInput)
    });
    assert(connection.id, `${connectionInput.name} should create a connection`);
    assert(!("password" in connection), `${connectionInput.name} must not expose password`);

    await request(`/api/connections/${connection.id}/test`, { method: "POST" });
    const schema = await request(`/api/connections/${connection.id}/schema`);
    assert(schema.tables.length > 0, `${connectionInput.name} should return schema tables`);
    assert(!schema.stale, `${connectionInput.name} should use live schema, not stale snapshot`);
    assert(
      schema.tables.some((table) => table.table.toLowerCase() === expectedTableName(connectionInput)),
      `${connectionInput.name} should include expected table ${expectedTableName(connectionInput)}`
    );

    const table = schema.tables.find((item) => item.table.toLowerCase() === expectedTableName(connectionInput));
    const firstColumn = table.columns[0].name;
    const sql = `select ${quoteIdentifier(firstColumn, connection.type)} from ${tableReference(table, connection.type)}`;
    const validation = await request("/api/sql/validate", {
      method: "POST",
      body: JSON.stringify({ connectionId: connection.id, sql, maxRows: 5 })
    });
    assert(validation.ok && validation.mode === "read-only", `${connectionInput.name} should validate read-only SQL`);

    const result = await request("/api/sql/run", {
      method: "POST",
      body: JSON.stringify({ connectionId: connection.id, sql, maxRows: 5 })
    });
    assert(result.auditId, `${connectionInput.name} should create an audit record`);
    assert(Array.isArray(result.rows), `${connectionInput.name} should return query rows`);

    const audits = await request(`/api/audits?connectionId=${connection.id}`);
    assert(audits.some((audit) => audit.id === result.auditId), `${connectionInput.name} should persist audit record`);

    console.log(`db integration passed: ${connectionInput.name} (${connectionInput.type})`);
  }
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await rm(tempDir, { recursive: true, force: true });
  if (stderr) process.stderr.write(stderr);
}
