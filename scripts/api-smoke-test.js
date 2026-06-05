import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const port = 3317;
const baseUrl = `http://127.0.0.1:${port}`;
const tempDir = await mkdtemp(path.join(tmpdir(), "dataio-test-"));
const storePath = path.join(tempDir, "catalog.json");

const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: String(port), DATAIO_STORE_PATH: storePath },
  stdio: ["ignore", "pipe", "pipe"]
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

async function request(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  return { response, body };
}

async function post(pathname, body) {
  return request(pathname, { method: "POST", body: JSON.stringify(body) });
}

async function waitForServer() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const { response, body } = await request("/api/health");
      if (response.ok && body.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Server did not start. stdout=${stdout} stderr=${stderr}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  await waitForServer();

  const created = await post("/api/connections", {
    name: "ERP Demo",
    type: "mysql",
    businessSystem: "ERP",
    host: "127.0.0.1",
    port: 3306,
    database: "erp",
    username: "readonly",
    password: "secret",
    note: "smoke test"
  });
  assert(created.response.status === 201, "connection should be created");
  assert(!("password" in created.body), "created connection must not expose password");

  const listed = await request("/api/connections");
  assert(listed.body.length === 1, "connection should be listed");
  assert(!("password" in listed.body[0]), "listed connection must not expose password");

  const updatedConnection = await request(`/api/connections/${created.body.id}`, {
    method: "PUT",
    body: JSON.stringify({ name: "ERP Demo Updated", note: "updated metadata" })
  });
  assert(updatedConnection.body.name === "ERP Demo Updated", "connection metadata should be updatable");
  assert(!("password" in updatedConnection.body), "updated connection must not expose password");

  const aiSettings = await post("/api/settings/ai", {
    name: "DeepSeek Test",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    apiKey: ""
  });
  assert(aiSettings.body.provider === "deepseek", "AI settings should be configurable");
  assert(!("apiKey" in aiSettings.body), "AI settings response must not expose API key");
  const aiSettingsList = await request("/api/settings/ai");
  assert(aiSettingsList.body.profiles.some((profile) => profile.name === "DeepSeek Test"), "AI settings should list profiles");
  await request(`/api/settings/ai/${aiSettings.body.id}/activate`, { method: "POST" });

  const importedSchema = await post(`/api/connections/${created.body.id}/schema/import`, {
    tables: [
      {
        schema: "public",
        table: "sale_order",
        columns: [
          { name: "id", type: "bigint" },
          { name: "customer_id", type: "varchar" },
          { name: "amount", type: "decimal" },
          { name: "mobile", type: "varchar" }
        ]
      }
    ]
  });
  assert(importedSchema.response.status === 201, "schema snapshot should be importable");
  assert(importedSchema.body.source === "manual-import", "schema snapshot source should be manual import");

  const schema = await request(`/api/connections/${created.body.id}/schema`);
  assert(schema.response.status === 200, "schema should fall back to imported snapshot when live connection fails");
  assert(schema.body.stale === true, "schema response should mark cached fallback as stale");
  assert(schema.body.tables[0].table === "sale_order", "schema fallback should include imported table");

  const annotation = await post("/api/annotations", {
    connectionId: created.body.id,
    targetType: "column",
    targetPath: "public.sale_order.customer_id",
    title: "客户ID",
    description: "销售订单关联客户主数据的字段",
    tags: ["客户", "订单"]
  });
  assert(annotation.response.status === 201, "annotation should be created");
  assert(annotation.body.title === "客户ID", "annotation should preserve Chinese text");
  assert(Array.isArray(annotation.body.warnings) && annotation.body.warnings.length === 0, "valid annotation path should not warn");

  const invalidAnnotation = await post("/api/annotations", {
    connectionId: created.body.id,
    targetType: "column",
    targetPath: "public.sale_order.missing_column",
    title: "错误字段",
    description: "用于验证路径校验提示",
    tags: ["测试"]
  });
  assert(invalidAnnotation.response.status === 201, "invalid annotation path should still be saveable");
  assert(invalidAnnotation.body.warnings.some((warning) => warning.includes("字段路径不在当前 Schema 快照中")), "invalid annotation path should warn");

  const columnSearch = await request("/api/catalog/search?q=customer_id");
  assert(columnSearch.body.results.some((result) => result.type === "column" && result.path.endsWith(".customer_id")), "catalog search should find schema column");

  const chineseSearch = await request(encodeURI("/api/catalog/search?q=客户"));
  assert(chineseSearch.body.results.some((result) => result.type === "annotation" && result.title === "客户ID"), "catalog search should find Chinese annotation");

  const coverage = await request("/api/catalog/coverage");
  const report = coverage.body.reports.find((item) => item.connection.id === created.body.id);
  assert(report.totals.tables === 1, "coverage should count schema tables");
  assert(report.totals.columns === 4, "coverage should count schema columns");
  assert(report.annotated.columns === 1, "coverage should count annotated columns");
  assert(report.coverage.columns === 25, "coverage should calculate column annotation percentage");
  assert(report.missing.columns.some((column) => column.endsWith(".amount")), "coverage should report missing column samples");

  const keyCoverage = await request("/api/catalog/coverage?scope=key");
  const keyReport = keyCoverage.body.reports.find((item) => item.connection.id === created.body.id);
  assert(keyReport.scope === "key", "coverage should support key-field scope");
  assert(keyReport.totals.columns === 3, "key-field scope should exclude low-value id column");

  const exportedCatalog = await request("/api/catalog/export");
  assert(exportedCatalog.body.connections.length === 1, "catalog export should include connection metadata");
  assert(!("password" in exportedCatalog.body.connections[0]), "catalog export must not include passwords");
  assert(exportedCatalog.body.annotations.length === 2, "catalog export should include annotations");
  assert(exportedCatalog.body.schemaSnapshots[created.body.id].tables.length === 1, "catalog export should include schema snapshots");

  const suggestion = await post("/api/ai/annotations/suggest", {
    connectionId: created.body.id,
    targetType: "column",
    targetPath: "public.sale_order.customer_id",
    sampleValues: ["C001", "C002"]
  });
  assert(suggestion.response.status === 200, "annotation suggestion should be generated");
  assert(suggestion.body.title.includes("客户") || suggestion.body.description.includes("客户"), "suggestion should infer Chinese business meaning");
  assert(suggestion.body.source === "rule-fallback" || suggestion.body.source === "openai", "suggestion should report source");

  const schemaContext = await post("/api/ai/schema-context/annotate", {
    connectionId: created.body.id,
    targetPath: "public.sale_order",
    context: "class SaleOrder(models.Model):\\n    customer_id = models.CharField(verbose_name='客户ID', max_length=64)\\n    amount = models.DecimalField(verbose_name='订单金额', max_digits=18, decimal_places=2)",
    persist: false
  });
  assert(schemaContext.body.suggested > 0, "schema context annotation should generate suggestions");
  assert(schemaContext.body.annotations.some((item) => item.targetType === "table"), "schema context annotation should include table suggestion");

  const missingPreview = await post("/api/ai/annotations/suggest-missing", {
    connectionId: created.body.id,
    limit: 2,
    persist: false
  });
  assert(missingPreview.body.suggested === 2, "missing annotation preview should suggest limited missing columns");
  assert(missingPreview.body.persisted === 0, "missing annotation preview should not persist by default");

  const missingPersisted = await post("/api/ai/annotations/suggest-missing", {
    connectionId: created.body.id,
    limit: 2,
    persist: true
  });
  assert(missingPersisted.body.persisted === 2, "missing annotation persist should save suggestions");

  const coverageAfterSuggestions = await request("/api/catalog/coverage");
  const reportAfterSuggestions = coverageAfterSuggestions.body.reports.find((item) => item.connection.id === created.body.id);
  assert(reportAfterSuggestions.annotated.columns === 3, "persisted suggestions should increase annotated column count");
  assert(reportAfterSuggestions.coverage.columns === 75, "persisted suggestions should increase column coverage");

  const updated = await request(`/api/annotations/${annotation.body.id}`, {
    method: "PUT",
    body: JSON.stringify({ description: "更新后的客户字段说明" })
  });
  assert(updated.body.description === "更新后的客户字段说明", "annotation should be updatable");

  const generated = await post("/api/ai/sql/generate", {
    connectionId: created.body.id,
    question: "查询 sale_order"
  });
  assert(generated.body.guarded === true, "AI SQL should be guarded");
  assert(/^select\b/i.test(generated.body.sql), "AI SQL fallback should be read-only");
  assert(generated.body.sql.includes("sale_order"), "AI SQL fallback should use cached schema");

  const readonly = await post("/api/sql/validate", {
    connectionId: created.body.id,
    sql: "select customer_id, mobile from public.sale_order",
    maxRows: 25
  });
  assert(readonly.body.ok === true, "read-only SQL should validate");
  assert(readonly.body.finalSql.toLowerCase().includes("limit 25"), "policy should apply max row limit");
  assert(readonly.body.referencedTables.includes("public.sale_order") || readonly.body.referencedTables.includes("sale_order"), "policy should detect referenced table");
  assert(readonly.body.maskedColumns.some((column) => column.includes("mobile")), "policy should report sensitive masked columns");

  const unknownTable = await post("/api/sql/validate", {
    connectionId: created.body.id,
    sql: "select * from public.unknown_table"
  });
  assert(unknownTable.body.unknownTables.length > 0, "policy should warn on tables missing from schema snapshot");

  const hyphenSchema = await post(`/api/connections/${created.body.id}/schema/import`, {
    tables: [
      {
        schema: "django-vue3-admin",
        table: "Manage_department",
        columns: [
          { name: "id", type: "bigint" },
          { name: "feishu_user_id", type: "varchar" }
        ]
      }
    ]
  });
  assert(hyphenSchema.response.status === 201, "hyphen schema snapshot should be importable");
  const hyphenSql = await post("/api/sql/validate", {
    connectionId: created.body.id,
    sql: "SELECT * FROM django-vue3-admin.Manage_department WHERE feishu_user_id IS NOT NULL"
  });
  assert(hyphenSql.body.finalSql.includes("`django-vue3-admin`.`Manage_department`"), "MySQL hyphenated schema should be quoted before execution");

  const blocked = await post("/api/sql/validate", { sql: "delete from users" });
  assert(blocked.response.status === 400 && /blocked|read-only/i.test(blocked.body.error), "write SQL should be blocked");

  const removedAnnotation = await request(`/api/annotations/${annotation.body.id}`, { method: "DELETE" });
  assert(removedAnnotation.body.ok === true, "annotation should be deletable");

  const removedConnection = await request(`/api/connections/${created.body.id}`, { method: "DELETE" });
  assert(removedConnection.body.ok === true, "connection should be deletable");

  const finalList = await request("/api/connections");
  assert(finalList.body.length === 0, "deleted connection should be gone");

  const importedCatalog = await post("/api/catalog/import", exportedCatalog.body);
  assert(importedCatalog.response.status === 201, "catalog import should succeed");
  assert(importedCatalog.body.importedConnections === 1, "catalog import should restore connection metadata");
  assert(importedCatalog.body.importedAnnotations === 2, "catalog import should restore annotations");
  assert(importedCatalog.body.importedSnapshots === 1, "catalog import should restore schema snapshots");

  const restoredSearch = await request("/api/catalog/search?q=customer_id");
  assert(restoredSearch.body.results.some((result) => result.type === "column" && result.path.endsWith(".customer_id")), "catalog import should restore searchable schema");

  const restoredCoverage = await request("/api/catalog/coverage");
  assert(restoredCoverage.body.reports[0].coverage.columns === 25, "catalog import should restore coverage metrics");

  console.log("api smoke test passed");
} finally {
  server.kill("SIGTERM");
  await new Promise((resolve) => server.once("exit", resolve));
  await rm(tempDir, { recursive: true, force: true });
}
