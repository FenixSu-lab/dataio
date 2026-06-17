import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { resetDemoData } from "./reset-demo-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const storePath = process.env.DATAIO_STORE_PATH
  ? path.resolve(process.env.DATAIO_STORE_PATH)
  : path.join(dataDir, "catalog.json");

const systems = ["ERP", "MES", "PLM", "CRM", "SRM", "OTHER"];
const domains = ["sales", "order", "inventory", "finance", "quality", "supplier", "product", "logistics"];
const sensitiveNames = ["customer_phone", "contact_email", "bank_account", "salary_amount", "id_card_no"];

function iso(daysAgo = 0) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

function buildTables(connectionIndex, tableCount) {
  const tables = [];
  for (let i = 1; i <= tableCount; i += 1) {
    const domain = domains[(connectionIndex + i) % domains.length];
    const table = `${domain}_fact_${String(i).padStart(2, "0")}`;
    const columns = [
      { name: "id", type: "varchar(64)", nullable: false },
      { name: "tenant_id", type: "varchar(32)", nullable: false },
      { name: "dept_code", type: "varchar(64)", nullable: false },
      { name: "owner_id", type: "varchar(64)", nullable: false },
      { name: "business_no", type: "varchar(64)", nullable: false },
      { name: "status", type: "varchar(32)", nullable: true },
      { name: "amount", type: "decimal(14,2)", nullable: true },
      { name: "event_time", type: "datetime", nullable: true },
      { name: sensitiveNames[i % sensitiveNames.length], type: "varchar(128)", nullable: true },
      { name: `metric_${(i % 5) + 1}`, type: "int", nullable: true },
    ];
    tables.push({ schema: domain, table, columns });
  }
  return tables;
}

function makeConnection(index) {
  const type = index % 3 === 0 ? "postgres" : index % 3 === 1 ? "mysql" : "sqlserver";
  const businessSystem = systems[index % systems.length];
  return {
    id: `conn-${String(index).padStart(3, "0")}`,
    name: `${businessSystem} ${type.toUpperCase()} Cluster ${String(index).padStart(2, "0")}`,
    type,
    driver: type === "mysql" ? "mysql2" : type === "postgres" ? "pg" : "mssql",
    businessSystem,
    host: `${businessSystem.toLowerCase()}-db-${index}.example.local`,
    port: type === "mysql" ? 3306 : type === "postgres" ? 5432 : 1433,
    database: `${businessSystem.toLowerCase()}_warehouse_${index}`,
    username: `readonly_${businessSystem.toLowerCase()}`,
    password: "",
    ssl: index % 2 === 0,
    note: "Medium demo catalog connection. Replace with real read-only credentials before live queries.",
    createdAt: iso(index),
  };
}

function makeAnnotation(connection, table, column = null, index = 0) {
  const targetPath = column
    ? `${table.schema}.${table.table}.${column.name}`
    : `${table.schema}.${table.table}`;
  return {
    id: randomUUID(),
    connectionId: connection.id,
    targetType: column ? "column" : "table",
    targetPath,
    title: column ? `Business rule for ${column.name}` : `Business definition for ${table.table}`,
    description: column
      ? `${column.name} is used by ${connection.businessSystem} reporting and data quality checks.`
      : `${table.table} is a curated table in the ${table.schema} domain.`,
    tags: column
      ? ["column", column.name.includes("amount") ? "metric" : "business"]
      : ["table", table.schema],
    updatedAt: iso(index % 30),
  };
}

async function seedMediumDemoData() {
  await resetDemoData();
  await mkdir(path.dirname(storePath), { recursive: true });

  const connections = [];
  const schemaSnapshots = {};
  const annotations = [];
  const audits = [];

  for (let index = 1; index <= 18; index += 1) {
    const connection = makeConnection(index);
    const tables = buildTables(index, 12);
    connections.push(connection);
    schemaSnapshots[connection.id] = {
      source: "medium-demo",
      refreshedAt: iso(index % 7),
      tables,
    };
    for (const [tableIndex, table] of tables.entries()) {
      annotations.push(makeAnnotation(connection, table, null, tableIndex));
      for (const column of table.columns.filter((item, columnIndex) => columnIndex < 6 || /phone|email|card|amount/.test(item.name))) {
        annotations.push(makeAnnotation(connection, table, column, tableIndex));
      }
    }
    for (let auditIndex = 1; auditIndex <= 8; auditIndex += 1) {
      audits.push({
        id: randomUUID(),
        connectionId: connection.id,
        sql: `SELECT * FROM ${tables[auditIndex % tables.length].schema}.${tables[auditIndex % tables.length].table} LIMIT 100`,
        createdAt: iso((index + auditIndex) % 45),
        policy: { mode: "read-only", maxRows: 100, guarded: true },
      });
    }
  }

  const aiProfiles = [
    { id: "ai-deepseek-prod", name: "DeepSeek Production", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "demo-key" },
    { id: "ai-openai-compatible", name: "OpenAI Compatible Backup", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "" },
    { id: "ai-local-lab", name: "Local Model Lab", provider: "local-llm", baseUrl: "http://model-gateway.local/v1", model: "qwen2.5-32b", apiKey: "" },
  ];
  const store = {
    connections,
    annotations,
    audits,
    schemaSnapshots,
    aiSettings: null,
    aiProfiles,
    activeAiProfileId: aiProfiles[0].id,
  };
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  return {
    connections: connections.length,
    schemaTables: Object.values(schemaSnapshots).reduce((sum, snapshot) => sum + snapshot.tables.length, 0),
    annotations: annotations.length,
    audits: audits.length,
    aiProfiles: aiProfiles.length,
  };
}

const counts = await seedMediumDemoData();
console.log("DataIO medium demo data seeded");
for (const [name, value] of Object.entries(counts)) console.log(`${name}: ${value}`);
