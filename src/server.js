import cors from "cors";
import express from "express";
import sqlParser from "node-sql-parser";
import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const storePath = process.env.DATAIO_STORE_PATH
  ? path.resolve(process.env.DATAIO_STORE_PATH)
  : path.join(dataDir, "catalog.json");
const { Parser } = sqlParser;
const parser = new Parser();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(rootDir, "public")));

const dbTypes = ["mysql", "postgres", "sqlserver"];
const businessSystems = ["ERP", "MES", "PLM", "CRM", "SRM", "OTHER"];
const sensitiveColumnPattern = /(phone|mobile|tel|email|id_card|card|bank|salary|身份证|手机号|电话|邮箱|银行|工资)/i;

const connectionSchema = z.object({
  name: z.string().min(1),
  type: z.enum(dbTypes),
  businessSystem: z.enum(businessSystems).default("OTHER"),
  host: z.string().min(1),
  port: z.coerce.number().int().positive(),
  database: z.string().min(1),
  username: z.string().min(1),
  password: z.string().optional().default(""),
  ssl: z.boolean().optional().default(false),
  note: z.string().optional().default("")
});

const connectionUpdateSchema = connectionSchema.partial();

const annotationSchema = z.object({
  connectionId: z.string().min(1),
  targetType: z.enum(["database", "table", "column", "enum", "join", "metric"]),
  targetPath: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).optional().default([])
});

const annotationUpdateSchema = annotationSchema.partial().omit({ connectionId: true });

const annotationSuggestSchema = z.object({
  connectionId: z.string().min(1),
  targetType: z.enum(["database", "table", "column", "enum", "join", "metric"]).default("column"),
  targetPath: z.string().min(1),
  sampleValues: z.array(z.string()).optional().default([])
});

const missingAnnotationSuggestSchema = z.object({
  connectionId: z.string().min(1),
  limit: z.coerce.number().int().positive().max(50).optional().default(10),
  persist: z.boolean().optional().default(false),
  scope: z.enum(["all", "key"]).optional().default("all")
});

const aiSettingsSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1).default("Default AI"),
  provider: z.string().min(1).default("openai-compatible"),
  baseUrl: z.string().url().optional().default("https://api.openai.com/v1"),
  apiKey: z.string().optional().default(""),
  model: z.string().min(1).default("gpt-4o-mini")
});

const schemaContextAnnotateSchema = z.object({
  connectionId: z.string().min(1),
  targetPath: z.string().min(1),
  context: z.string().min(1),
  persist: z.boolean().optional().default(false)
});

const columnSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  nullable: z.union([z.string(), z.boolean(), z.number()]).optional(),
  default: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional()
});

const tableSchema = z.object({
  schema: z.string().min(1),
  table: z.string().min(1),
  columns: z.array(columnSchema).min(1)
});

const schemaImportSchema = z.object({
  tables: z.array(tableSchema).min(1)
});

const catalogImportSchema = z.object({
  version: z.string().optional(),
  exportedAt: z.string().optional(),
  connections: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.enum(dbTypes),
    businessSystem: z.enum(businessSystems),
    host: z.string().optional(),
    port: z.number().optional(),
    database: z.string().min(1),
    username: z.string().optional(),
    ssl: z.boolean().optional(),
    note: z.string().optional(),
    createdAt: z.string().optional()
  })).optional().default([]),
  annotations: z.array(annotationSchema.extend({
    id: z.string().optional(),
    updatedAt: z.string().optional()
  })).optional().default([]),
  schemaSnapshots: z.record(z.object({
    source: z.string().optional(),
    refreshedAt: z.string().optional(),
    tables: z.array(tableSchema)
  })).optional().default({})
});

function emptyStore() {
  return { connections: [], annotations: [], audits: [], schemaSnapshots: {}, aiSettings: null, aiProfiles: [], activeAiProfileId: null };
}

function normalizeStore(store) {
  return {
    ...emptyStore(),
    ...store,
    connections: Array.isArray(store?.connections) ? store.connections : [],
    annotations: Array.isArray(store?.annotations) ? store.annotations : [],
    audits: Array.isArray(store?.audits) ? store.audits : [],
    schemaSnapshots: store?.schemaSnapshots && typeof store.schemaSnapshots === "object" ? store.schemaSnapshots : {},
    aiSettings: store?.aiSettings && typeof store.aiSettings === "object" ? store.aiSettings : null,
    aiProfiles: Array.isArray(store?.aiProfiles) ? store.aiProfiles : (store?.aiSettings ? [{ id: "default", name: "Default AI", ...store.aiSettings }] : []),
    activeAiProfileId: typeof store?.activeAiProfileId === "string"
      ? store.activeAiProfileId
      : (Array.isArray(store?.aiProfiles) && store.aiProfiles[0]?.id) || (store?.aiSettings ? "default" : null)
  };
}

async function loadStore() {
  await mkdir(dataDir, { recursive: true });
  try {
    return normalizeStore(JSON.parse(await readFile(storePath, "utf8")));
  } catch {
    return emptyStore();
  }
}

async function saveStore(store) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

function publicConnection(connection) {
  const { password, ...safe } = connection;
  return safe;
}

function requireConnection(store, id) {
  const connection = store.connections.find((item) => item.id === id);
  if (!connection) {
    const error = new Error("Connection not found");
    error.status = 404;
    throw error;
  }
  return connection;
}

function requireAnnotation(store, id) {
  const annotation = store.annotations.find((item) => item.id === id);
  if (!annotation) {
    const error = new Error("Annotation not found");
    error.status = 404;
    throw error;
  }
  return annotation;
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function assertReadOnlySql(sql) {
  const normalized = sql.trim().replace(/;+\s*$/g, "");
  if (!normalized) throw badRequest("SQL is empty");
  if (/;/.test(normalized)) throw badRequest("Only one SQL statement is allowed");
  if (!/^(select|with|show|desc|describe|explain)\b/i.test(normalized)) {
    throw badRequest("Only read-only SQL is allowed");
  }
  if (/\b(insert|update|delete|merge|drop|alter|truncate|create|replace|grant|revoke|call|exec|execute|copy)\b/i.test(normalized)) {
    throw badRequest("Write or administrative SQL is blocked");
  }
  try {
    parser.astify(normalized, { database: "postgresql" });
  } catch {
    if (!/^(show|desc|describe|explain)\b/i.test(normalized)) {
      throw badRequest("SQL syntax could not be parsed safely");
    }
  }
  return normalized;
}

function collectAstTables(node, tables = new Set()) {
  if (!node || typeof node !== "object") return tables;
  if (Array.isArray(node)) {
    for (const item of node) collectAstTables(item, tables);
    return tables;
  }
  if (node.table && typeof node.table === "string") {
    const tableName = [node.db, node.table].filter(Boolean).join(".");
    tables.add(tableName);
  }
  for (const value of Object.values(node)) {
    collectAstTables(value, tables);
  }
  return tables;
}

function collectSchemaColumns(tables) {
  const columns = new Set();
  for (const table of tables) {
    for (const column of table.columns ?? []) {
      columns.add(column.name);
      columns.add(`${table.schema}.${table.table}.${column.name}`);
    }
  }
  return columns;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteIdentifierForSql(identifier, type) {
  if (type === "mysql") return `\`${String(identifier).replaceAll("`", "``")}\``;
  if (type === "sqlserver") return `[${String(identifier).replaceAll("]", "]]")}]`;
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function normalizeKnownTableReferences(sql, connection, schemaTables = []) {
  if (connection.type !== "mysql") return sql;
  let normalized = sql;
  for (const table of schemaTables) {
    const fullPath = `${table.schema}.${table.table}`;
    const quotedFullPath = `${quoteIdentifierForSql(table.schema, connection.type)}.${quoteIdentifierForSql(table.table, connection.type)}`;
    normalized = normalized.replace(
      new RegExp(`(?<![\\w\`])${escapeRegExp(fullPath)}(?![\\w\`])`, "g"),
      quotedFullPath
    );
    normalized = normalized.replace(
      new RegExp(`(?<![\\w\`\\.])${escapeRegExp(table.table)}(?![\\w\`])`, "g"),
      quoteIdentifierForSql(table.table, connection.type)
    );
  }
  return normalized;
}

function analyzeSqlPolicy(sql, connection, schemaTables = [], maxRows = 100) {
  const readonlySql = assertReadOnlySql(sql);
  const normalizedSql = normalizeKnownTableReferences(readonlySql, connection, schemaTables);
  const finalSql = ensureLimit(normalizedSql, connection.type, maxRows);
  let referencedTables = [];
  try {
    const ast = parser.astify(readonlySql, { database: "postgresql" });
    referencedTables = [...collectAstTables(ast)];
  } catch {
    referencedTables = [];
  }
  const schemaTableNames = new Set(schemaTables.flatMap((table) => [
    table.table.toLowerCase(),
    `${table.schema}.${table.table}`.toLowerCase()
  ]));
  const unknownTables = referencedTables.filter((table) => !schemaTableNames.has(table.toLowerCase()));
  const schemaColumns = collectSchemaColumns(schemaTables);
  const maskedColumns = [...schemaColumns].filter((column) => sensitiveColumnPattern.test(column)).sort();
  const warnings = [];
  if (finalSql !== readonlySql) warnings.push(`已自动限制最多返回 ${Math.max(1, Math.min(Number(maxRows) || 100, 1000))} 行`);
  if (!referencedTables.length) warnings.push("未能从 SQL 中识别出表名，请人工确认查询范围");
  if (unknownTables.length) warnings.push(`SQL 引用了快照中不存在的表：${unknownTables.join(", ")}`);
  if (maskedColumns.length) warnings.push(`命中敏感字段规则，结果会按字段名脱敏：${maskedColumns.slice(0, 20).join(", ")}`);
  return {
    ok: true,
    mode: "read-only",
    originalSql: readonlySql,
    normalizedSql,
    finalSql,
    maxRows: Math.max(1, Math.min(Number(maxRows) || 100, 1000)),
    referencedTables,
    unknownTables,
    maskedColumns,
    warnings
  };
}

function ensureLimit(sql, type, maxRows = 100) {
  const normalized = sql.trim().replace(/;+\s*$/g, "");
  const safeMaxRows = Math.max(1, Math.min(Number(maxRows) || 100, 1000));
  if (/\blimit\s+\d+\b/i.test(normalized) || /\btop\s+\d+\b/i.test(normalized) || /\boffset\s+\d+\s+rows\b/i.test(normalized)) {
    return normalized;
  }
  if (/^select\s+1$/i.test(normalized)) {
    return normalized;
  }
  if (type === "sqlserver") {
    return normalized.replace(/^select\s+/i, `SELECT TOP ${safeMaxRows} `);
  }
  return `${normalized} LIMIT ${safeMaxRows}`;
}

function maskRows(rows) {
  return rows.map((row) => {
    const masked = {};
    for (const [key, value] of Object.entries(row)) {
      masked[key] = sensitiveColumnPattern.test(key) && value != null ? "***MASKED***" : value;
    }
    return masked;
  });
}

function publicAiSettings(settings) {
  if (!settings) return null;
  const { apiKey, ...safe } = settings;
  return { ...safe, hasApiKey: Boolean(apiKey) };
}

function getAiConfig(store) {
  const settings = store?.aiProfiles?.find((profile) => profile.id === store?.activeAiProfileId) ?? store?.aiSettings;
  const apiKey = settings?.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return {
    apiKey,
    baseURL: settings?.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    model: settings?.model || process.env.OPENAI_MODEL || "gpt-4o-mini"
  };
}

function createOpenAIClient(aiConfig) {
  return new OpenAI({ apiKey: aiConfig.apiKey, baseURL: aiConfig.baseURL });
}

function humanizeIdentifier(identifier) {
  const normalized = identifier
    .replace(/[`"[\]]/g, "")
    .split(".")
    .at(-1)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  const dictionary = new Map([
    ["id", "ID"],
    ["no", "编号"],
    ["code", "编码"],
    ["name", "名称"],
    ["desc", "描述"],
    ["type", "类型"],
    ["status", "状态"],
    ["date", "日期"],
    ["time", "时间"],
    ["created", "创建"],
    ["updated", "更新"],
    ["create", "创建"],
    ["update", "更新"],
    ["customer", "客户"],
    ["cust", "客户"],
    ["supplier", "供应商"],
    ["vendor", "供应商"],
    ["material", "物料"],
    ["item", "物料"],
    ["product", "产品"],
    ["order", "订单"],
    ["sale", "销售"],
    ["sales", "销售"],
    ["purchase", "采购"],
    ["qty", "数量"],
    ["quantity", "数量"],
    ["amount", "金额"],
    ["price", "价格"],
    ["dept", "部门"],
    ["org", "组织"],
    ["user", "用户"],
    ["owner", "负责人"],
    ["phone", "电话"],
    ["mobile", "手机号"],
    ["email", "邮箱"]
  ]);
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => dictionary.get(part) ?? part)
    .join("");
}

function fallbackAnnotationSuggestion(connection, input, relatedAnnotations) {
  const title = humanizeIdentifier(input.targetPath);
  const context = relatedAnnotations.length
    ? `已有关联标注：${relatedAnnotations.slice(0, 3).map((item) => item.title).join("、")}。`
    : "暂无关联标注。";
  const sampleText = input.sampleValues.length ? `样例值：${input.sampleValues.slice(0, 5).join("、")}。` : "";
  const typeText = {
    database: "数据库",
    table: "业务表",
    column: "字段",
    enum: "枚举",
    join: "常用关联关系",
    metric: "业务口径"
  }[input.targetType];
  return {
    targetType: input.targetType,
    targetPath: input.targetPath,
    title,
    description: `${typeText}“${input.targetPath}”建议标注为“${title}”。请结合 ${connection.businessSystem} 业务场景补充来源系统、业务含义、取值范围和使用注意事项。${sampleText}${context}`,
    tags: [connection.businessSystem, input.targetType, title].filter(Boolean),
    confidence: relatedAnnotations.length ? "medium" : "low",
    source: "rule-fallback"
  };
}

function buildAnnotationPrompt(connection, input, relatedAnnotations) {
  return [
    "你是企业数据字典专家，任务是为数据库对象生成中文业务标注建议。",
    "输出 JSON，不要 Markdown。字段包括 title、description、tags、confidence。",
    `业务系统：${connection.businessSystem}`,
    `数据库类型：${connection.type}`,
    `数据库：${connection.database}`,
    `对象类型：${input.targetType}`,
    `对象路径：${input.targetPath}`,
    `样例值：${input.sampleValues.join("、") || "无"}`,
    "相关已有标注：",
    relatedAnnotations.map((item) => `${item.targetType} ${item.targetPath}: ${item.description}`).join("\n") || "无",
    "要求：中文、简洁、面向 ERP/MES/PLM/CRM/SRM 业务用户，说明业务含义、可能枚举或关联关系。"
  ].join("\n");
}

function fallbackSchemaContextAnnotations(connection, input) {
  const tableTitle = humanizeIdentifier(input.targetPath);
  const candidates = [...input.context.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=|:|\()/g)]
    .map((match) => match[1])
    .filter((name) => !["class", "models", "CharField", "IntegerField", "DateTimeField", "ForeignKey", "TextField"].includes(name))
    .slice(0, 20);
  const uniqueColumns = [...new Set(candidates)];
  return {
    source: "rule-fallback",
    annotations: [
      {
        targetType: "table",
        targetPath: input.targetPath,
        title: tableTitle,
        description: `根据粘贴的模型/Schema 内容推断：${input.targetPath} 是 ${connection.businessSystem} 业务表。请结合业务补充表用途、数据来源和使用边界。`,
        tags: [connection.businessSystem, "表说明"]
      },
      ...uniqueColumns.map((column) => ({
        targetType: "column",
        targetPath: `${input.targetPath}.${column}`,
        title: humanizeIdentifier(column),
        description: `根据模型/Schema 内容推断字段“${column}”的业务含义。请结合代码注释、verbose_name、choices 或 help_text 完善说明。`,
        tags: [connection.businessSystem, "AI建议"]
      }))
    ]
  };
}

function buildSchemaContextPrompt(connection, input) {
  return [
    "你是企业数据字典专家。用户会粘贴 Django Model、DDL、ORM 模型或其他 Schema 描述。",
    "请从中提取表说明、关键字段说明、枚举、关联关系。只输出 JSON，不要 Markdown。",
    "JSON 格式：{\"annotations\":[{\"targetType\":\"table|column|enum|join|metric\",\"targetPath\":\"...\",\"title\":\"...\",\"description\":\"...\",\"tags\":[\"...\"]}]}",
    `业务系统：${connection.businessSystem}`,
    `目标表路径：${input.targetPath}`,
    "要求：不要为 id、created_at、updated_at 等低价值通用字段生成标注，优先输出业务表说明和关键业务字段。",
    "粘贴内容：",
    input.context
  ].join("\n");
}

async function suggestAnnotationsFromSchemaContext(connection, input, store) {
  const fallback = fallbackSchemaContextAnnotations(connection, input);
  const aiConfig = getAiConfig(store);
  if (!aiConfig) return fallback;
  const openai = createOpenAIClient(aiConfig);
  const completion = await openai.chat.completions.create({
    model: aiConfig.model,
    temperature: 0.2,
    messages: [{ role: "user", content: buildSchemaContextPrompt(connection, input) }],
    response_format: { type: "json_object" }
  });
  const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
  return {
    source: "openai-compatible",
    annotations: Array.isArray(parsed.annotations) ? parsed.annotations : fallback.annotations
  };
}

async function suggestAnnotation(connection, input, relatedAnnotations, store = null) {
  const fallback = fallbackAnnotationSuggestion(connection, input, relatedAnnotations);
  const aiConfig = getAiConfig(store);
  if (!aiConfig) return fallback;
  const openai = createOpenAIClient(aiConfig);
  const completion = await openai.chat.completions.create({
    model: aiConfig.model,
    temperature: 0.2,
    messages: [{ role: "user", content: buildAnnotationPrompt(connection, input, relatedAnnotations) }],
    response_format: { type: "json_object" }
  });
  const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
  return {
    targetType: input.targetType,
    targetPath: input.targetPath,
    title: String(parsed.title || fallback.title),
    description: String(parsed.description || fallback.description),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : fallback.tags,
    confidence: String(parsed.confidence || "medium"),
    source: "openai"
  };
}

async function createClient(connection) {
  if (connection.type === "postgres") {
    const pg = await import("pg");
    const { Client } = pg.default ?? pg;
    const client = new Client({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ssl: connection.ssl ? { rejectUnauthorized: false } : false
    });
    await client.connect();
    return {
      query: async (sql) => (await client.query(sql)).rows,
      close: () => client.end()
    };
  }
  if (connection.type === "mysql") {
    const mysqlModule = await import("mysql2/promise");
    const mysql = mysqlModule.default ?? mysqlModule;
    const client = await mysql.createConnection({
      host: connection.host,
      port: connection.port,
      database: connection.database,
      user: connection.username,
      password: connection.password,
      ssl: connection.ssl ? {} : undefined
    });
    return {
      query: async (sql) => {
        const [rows] = await client.query(sql);
        return rows;
      },
      close: () => client.end()
    };
  }
  const mssql = await import("mssql");
  const sql = mssql.default ?? mssql;
  const pool = await sql.connect({
    server: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.username,
    password: connection.password,
    options: { encrypt: connection.ssl, trustServerCertificate: true, readOnlyIntent: true }
  });
  return {
    query: async (queryText) => (await pool.request().query(queryText)).recordset,
    close: () => pool.close()
  };
}

async function withClient(connection, callback) {
  const client = await createClient(connection);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

async function introspectSchema(connection) {
  return withClient(connection, async (client) => {
    if (connection.type === "postgres") {
      return client.query(`
        select table_schema as schema, table_name as table, column_name as column,
               data_type as type, is_nullable as nullable, column_default as default
        from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema')
        order by table_schema, table_name, ordinal_position
      `);
    }
    if (connection.type === "mysql") {
      return client.query(`
        select table_schema as \`schema\`, table_name as \`table\`, column_name as \`column\`,
               column_type as type, is_nullable as nullable, column_default as \`default\`
        from information_schema.columns
        where table_schema = database()
        order by table_schema, table_name, ordinal_position
      `);
    }
    return client.query(`
      select s.name as [schema], t.name as [table], c.name as [column],
             ty.name as [type], c.is_nullable as [nullable], dc.definition as [default]
      from sys.tables t
      join sys.schemas s on t.schema_id = s.schema_id
      join sys.columns c on c.object_id = t.object_id
      join sys.types ty on c.user_type_id = ty.user_type_id
      left join sys.default_constraints dc on c.default_object_id = dc.object_id
      order by s.name, t.name, c.column_id
    `);
  });
}

function groupSchema(rows) {
  const tables = new Map();
  for (const row of rows) {
    const key = `${row.schema}.${row.table}`;
    if (!tables.has(key)) {
      tables.set(key, { schema: row.schema, table: row.table, columns: [] });
    }
    tables.get(key).columns.push({
      name: row.column,
      type: row.type,
      nullable: row.nullable,
      default: row.default
    });
  }
  return [...tables.values()];
}

function saveSchemaSnapshot(store, connectionId, tables, source) {
  store.schemaSnapshots[connectionId] = {
    source,
    refreshedAt: new Date().toISOString(),
    tables
  };
  return store.schemaSnapshots[connectionId];
}

function getSchemaSnapshot(store, connectionId) {
  return store.schemaSnapshots[connectionId] ?? null;
}

function includesQuery(value, query) {
  return String(value ?? "").toLowerCase().includes(query);
}

function scoreSearchText(parts, query) {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (!query) return 1;
  if (!text.includes(query)) return 0;
  const exactBoost = parts.some((part) => String(part ?? "").toLowerCase() === query) ? 10 : 0;
  const startsBoost = parts.some((part) => String(part ?? "").toLowerCase().startsWith(query)) ? 5 : 0;
  return 1 + exactBoost + startsBoost;
}

function buildCatalogSearchResults(store, query, connectionId) {
  const normalizedQuery = String(query ?? "").trim().toLowerCase();
  const connections = connectionId
    ? store.connections.filter((connection) => connection.id === connectionId)
    : store.connections;
  const connectionById = new Map(store.connections.map((connection) => [connection.id, connection]));
  const results = [];

  for (const connection of connections) {
    const score = scoreSearchText([connection.name, connection.type, connection.businessSystem, connection.host, connection.database, connection.note], normalizedQuery);
    if (score) {
      results.push({
        type: "connection",
        score,
        connection: publicConnection(connection),
        title: connection.name,
        path: connection.database,
        description: `${connection.businessSystem} · ${connection.type} · ${connection.host}:${connection.port}/${connection.database}`
      });
    }

    const snapshot = getSchemaSnapshot(store, connection.id);
    for (const table of snapshot?.tables ?? []) {
      const tablePath = `${table.schema}.${table.table}`;
      const tableScore = scoreSearchText([table.schema, table.table, tablePath, connection.name, connection.businessSystem], normalizedQuery);
      if (tableScore) {
        results.push({
          type: "table",
          score: tableScore,
          connection: publicConnection(connection),
          title: table.table,
          path: tablePath,
          description: `${table.columns.length} 个字段 · Schema ${snapshot.source}`,
          schemaSource: snapshot.source,
          refreshedAt: snapshot.refreshedAt
        });
      }
      for (const column of table.columns) {
        const columnPath = `${tablePath}.${column.name}`;
        const columnScore = scoreSearchText([column.name, column.type, columnPath, table.table, connection.name, connection.businessSystem], normalizedQuery);
        if (columnScore) {
          results.push({
            type: "column",
            score: columnScore,
            connection: publicConnection(connection),
            title: column.name,
            path: columnPath,
            description: `${column.type}${column.nullable !== undefined ? ` · nullable=${column.nullable}` : ""}`,
            schemaSource: snapshot.source,
            refreshedAt: snapshot.refreshedAt
          });
        }
      }
    }
  }

  const annotations = connectionId
    ? store.annotations.filter((annotation) => annotation.connectionId === connectionId)
    : store.annotations;
  for (const annotation of annotations) {
    const annotationConnection = connectionById.get(annotation.connectionId);
    const score = scoreSearchText([
      annotation.title,
      annotation.description,
      annotation.targetType,
      annotation.targetPath,
      ...(annotation.tags ?? [])
    ], normalizedQuery);
    if (score) {
      results.push({
        type: "annotation",
        score: score + 2,
        connection: annotationConnection ? publicConnection(annotationConnection) : null,
        title: annotation.title,
        path: annotation.targetPath,
        description: annotation.description,
        targetType: annotation.targetType,
        tags: annotation.tags ?? [],
        annotationId: annotation.id,
        updatedAt: annotation.updatedAt
      });
    }
  }

  return results
    .filter((result) => !normalizedQuery || result.score > 0 || includesQuery(result.description, normalizedQuery))
    .sort((left, right) => right.score - left.score || left.type.localeCompare(right.type))
    .slice(0, 100)
    .map(({ score, ...result }) => result);
}

function percent(part, total) {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function isLowValueTable(tablePath) {
  return /(^|[_.])(log|logs|audit|history|captcha|session|permission|permissions)([_.]|$)/i.test(tablePath);
}

function isLowValueColumn(columnName) {
  return /^(id|pk|uuid|created_at|updated_at|deleted_at|create_time|update_time|delete_time|created_by|updated_by|is_deleted|remark|remarks|sort|status)$/i.test(columnName);
}

function shouldTrackColumn(table, column, scope) {
  if (scope !== "key") return true;
  const tablePath = `${table.schema}.${table.table}`;
  if (isLowValueTable(tablePath)) return false;
  if (isLowValueColumn(column.name)) return false;
  return true;
}

function buildCoverageReport(store, connectionId, scope = "all") {
  const connections = connectionId
    ? store.connections.filter((connection) => connection.id === connectionId)
    : store.connections;
  return connections.map((connection) => {
    const snapshot = getSchemaSnapshot(store, connection.id);
    const annotations = store.annotations.filter((annotation) => annotation.connectionId === connection.id);
    const tableAnnotations = new Set(
      annotations.filter((annotation) => annotation.targetType === "table").map((annotation) => annotation.targetPath.toLowerCase())
    );
    const columnAnnotations = new Set(
      annotations.filter((annotation) => annotation.targetType === "column").map((annotation) => annotation.targetPath.toLowerCase())
    );
    const tables = snapshot?.tables ?? [];
    const trackedTables = scope === "key" ? tables.filter((table) => !isLowValueTable(`${table.schema}.${table.table}`)) : tables;
    const tablePaths = trackedTables.map((table) => `${table.schema}.${table.table}`);
    const columnPaths = trackedTables.flatMap((table) => table.columns
      .filter((column) => shouldTrackColumn(table, column, scope))
      .map((column) => `${table.schema}.${table.table}.${column.name}`));
    const annotatedTables = tablePaths.filter((tablePath) => tableAnnotations.has(tablePath.toLowerCase()));
    const annotatedColumns = columnPaths.filter((columnPath) => columnAnnotations.has(columnPath.toLowerCase()));
    const missingTables = tablePaths.filter((tablePath) => !tableAnnotations.has(tablePath.toLowerCase())).slice(0, 20);
    const missingColumns = columnPaths.filter((columnPath) => !columnAnnotations.has(columnPath.toLowerCase())).slice(0, 50);
    return {
      connection: publicConnection(connection),
      scope,
      schemaSource: snapshot?.source ?? null,
      refreshedAt: snapshot?.refreshedAt ?? null,
      totals: {
        tables: tablePaths.length,
        columns: columnPaths.length,
        rawTables: tables.length,
        rawColumns: tables.flatMap((table) => table.columns ?? []).length,
        annotations: annotations.length,
        enumAnnotations: annotations.filter((annotation) => annotation.targetType === "enum").length,
        joinAnnotations: annotations.filter((annotation) => annotation.targetType === "join").length,
        metricAnnotations: annotations.filter((annotation) => annotation.targetType === "metric").length
      },
      coverage: {
        tables: percent(annotatedTables.length, tablePaths.length),
        columns: percent(annotatedColumns.length, columnPaths.length)
      },
      annotated: {
        tables: annotatedTables.length,
        columns: annotatedColumns.length
      },
      missing: {
        tables: missingTables,
        columns: missingColumns
      }
    };
  });
}

function missingColumnPathsForConnection(store, connectionId, scope = "all") {
  const snapshot = getSchemaSnapshot(store, connectionId);
  if (!snapshot) return [];
  const columnAnnotations = new Set(
    store.annotations
      .filter((annotation) => annotation.connectionId === connectionId && annotation.targetType === "column")
      .map((annotation) => annotation.targetPath.toLowerCase())
  );
  return snapshot.tables
    .filter((table) => scope !== "key" || !isLowValueTable(`${table.schema}.${table.table}`))
    .flatMap((table) => table.columns
      .filter((column) => shouldTrackColumn(table, column, scope))
      .map((column) => `${table.schema}.${table.table}.${column.name}`))
    .filter((columnPath) => !columnAnnotations.has(columnPath.toLowerCase()));
}

function persistAnnotationSuggestions(store, connectionId, suggestions) {
  const existingKeys = new Set(
    store.annotations.map((annotation) => `${annotation.connectionId}:${annotation.targetType}:${annotation.targetPath}`.toLowerCase())
  );
  const created = [];
  for (const suggestion of suggestions) {
    const key = `${connectionId}:${suggestion.targetType}:${suggestion.targetPath}`.toLowerCase();
    if (existingKeys.has(key)) continue;
    const annotation = {
      id: randomUUID(),
      updatedAt: new Date().toISOString(),
      connectionId,
      targetType: suggestion.targetType,
      targetPath: suggestion.targetPath,
      title: suggestion.title,
      description: suggestion.description,
      tags: [...new Set([...(suggestion.tags ?? []), "AI建议"])]
    };
    store.annotations.push(annotation);
    existingKeys.add(key);
    created.push(annotation);
  }
  return created;
}

function validateAnnotationTarget(store, annotation) {
  const warnings = [];
  const snapshot = getSchemaSnapshot(store, annotation.connectionId);
  if (!snapshot) {
    warnings.push("当前连接没有 Schema 快照，无法校验标注路径是否存在");
    return warnings;
  }
  const tablePaths = new Set(snapshot.tables.map((table) => `${table.schema}.${table.table}`.toLowerCase()));
  const columnPaths = new Set(
    snapshot.tables.flatMap((table) => table.columns.map((column) => `${table.schema}.${table.table}.${column.name}`.toLowerCase()))
  );
  const targetPath = annotation.targetPath.toLowerCase();
  if (annotation.targetType === "table" && !tablePaths.has(targetPath)) {
    warnings.push(`表路径不在当前 Schema 快照中：${annotation.targetPath}`);
  }
  if (annotation.targetType === "column" && !columnPaths.has(targetPath)) {
    warnings.push(`字段路径不在当前 Schema 快照中：${annotation.targetPath}`);
  }
  return warnings;
}

function exportKnowledgeCatalog(store) {
  return {
    version: "1",
    exportedAt: new Date().toISOString(),
    connections: store.connections.map((connection) => publicConnection(connection)),
    annotations: store.annotations,
    schemaSnapshots: store.schemaSnapshots
  };
}

function importKnowledgeCatalog(store, payload) {
  const input = catalogImportSchema.parse(payload);
  const existingConnectionIds = new Set(store.connections.map((connection) => connection.id));
  let importedConnections = 0;
  let importedAnnotations = 0;
  let importedSnapshots = 0;

  for (const connection of input.connections) {
    if (existingConnectionIds.has(connection.id)) continue;
    store.connections.push({
      ...connection,
      host: connection.host ?? "imported.local",
      port: connection.port ?? 0,
      username: connection.username ?? "imported",
      password: "",
      ssl: connection.ssl ?? false,
      note: connection.note ?? "Imported knowledge catalog; add real connection details before testing.",
      createdAt: connection.createdAt ?? new Date().toISOString()
    });
    existingConnectionIds.add(connection.id);
    importedConnections += 1;
  }

  const validConnectionIds = new Set(store.connections.map((connection) => connection.id));
  const existingAnnotationKeys = new Set(store.annotations.map((annotation) => `${annotation.connectionId}:${annotation.targetType}:${annotation.targetPath}:${annotation.title}`.toLowerCase()));
  for (const annotation of input.annotations) {
    if (!validConnectionIds.has(annotation.connectionId)) continue;
    const key = `${annotation.connectionId}:${annotation.targetType}:${annotation.targetPath}:${annotation.title}`.toLowerCase();
    if (existingAnnotationKeys.has(key)) continue;
    store.annotations.push({
      ...annotation,
      id: annotation.id ?? randomUUID(),
      updatedAt: annotation.updatedAt ?? new Date().toISOString()
    });
    existingAnnotationKeys.add(key);
    importedAnnotations += 1;
  }

  for (const [connectionId, snapshot] of Object.entries(input.schemaSnapshots)) {
    if (!validConnectionIds.has(connectionId)) continue;
    store.schemaSnapshots[connectionId] = {
      source: snapshot.source ?? "catalog-import",
      refreshedAt: snapshot.refreshedAt ?? new Date().toISOString(),
      tables: snapshot.tables
    };
    importedSnapshots += 1;
  }

  return { importedConnections, importedAnnotations, importedSnapshots };
}

function buildPrompt(question, connection, schema, annotations) {
  return [
    "你是企业业务数据库 SQL 助手，只能生成只读 SQL。",
    `业务系统：${connection.businessSystem}，数据库类型：${connection.type}，库名：${connection.database}`,
    `用户问题：${question}`,
    "可用表字段：",
    schema.slice(0, 80).map((table) => `${table.schema}.${table.table}(${table.columns.map((col) => `${col.name}:${col.type}`).join(", ")})`).join("\n"),
    "业务标注：",
    annotations.slice(0, 80).map((item) => `${item.targetType} ${item.targetPath}: ${item.description}`).join("\n"),
    "只返回 SQL，不要解释。禁止 INSERT/UPDATE/DELETE/DDL。"
  ].join("\n");
}

function fallbackSql(question, schema) {
  const text = question.toLowerCase();
  const hit = schema.find((table) => text.includes(table.table.toLowerCase())) ?? schema[0];
  if (!hit) return "SELECT 1";
  return `SELECT * FROM ${hit.schema}.${hit.table} LIMIT 100`;
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "dataio", mode: "read-only" });
});

app.get("/api/settings/ai", async (_request, response, next) => {
  try {
    const store = await loadStore();
    response.json({
      profiles: store.aiProfiles.map(publicAiSettings),
      activeProfileId: store.activeAiProfileId,
      envFallback: {
        provider: "env",
        baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
        hasApiKey: Boolean(process.env.OPENAI_API_KEY)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/ai", async (request, response, next) => {
  try {
    const input = aiSettingsSchema.parse(request.body);
    const store = await loadStore();
    const profile = {
      id: input.id || randomUUID(),
      name: input.name,
      provider: input.provider,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKey: input.apiKey || ""
    };
    store.aiProfiles.push(profile);
    store.activeAiProfileId = store.activeAiProfileId || profile.id;
    await saveStore(store);
    response.status(201).json(publicAiSettings(profile));
  } catch (error) {
    next(error);
  }
});

app.put("/api/settings/ai/:id", async (request, response, next) => {
  try {
    const input = aiSettingsSchema.partial().parse(request.body);
    const store = await loadStore();
    const profile = store.aiProfiles.find((item) => item.id === request.params.id);
    if (!profile) {
      const error = new Error("AI profile not found");
      error.status = 404;
      throw error;
    }
    Object.assign(profile, input, { apiKey: input.apiKey || profile.apiKey });
    await saveStore(store);
    response.json(publicAiSettings(profile));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/settings/ai/:id", async (request, response, next) => {
  try {
    const store = await loadStore();
    store.aiProfiles = store.aiProfiles.filter((profile) => profile.id !== request.params.id);
    if (store.activeAiProfileId === request.params.id) {
      store.activeAiProfileId = store.aiProfiles[0]?.id ?? null;
    }
    await saveStore(store);
    response.json({ ok: true, activeProfileId: store.activeAiProfileId });
  } catch (error) {
    next(error);
  }
});

app.post("/api/settings/ai/:id/activate", async (request, response, next) => {
  try {
    const store = await loadStore();
    const profile = store.aiProfiles.find((item) => item.id === request.params.id);
    if (!profile) {
      const error = new Error("AI profile not found");
      error.status = 404;
      throw error;
    }
    store.activeAiProfileId = profile.id;
    await saveStore(store);
    response.json({ ok: true, activeProfileId: profile.id });
  } catch (error) {
    next(error);
  }
});

app.get("/api/catalog/search", async (request, response, next) => {
  try {
    const store = await loadStore();
    response.json({
      query: String(request.query.q ?? ""),
      results: buildCatalogSearchResults(store, request.query.q, request.query.connectionId)
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/catalog/coverage", async (request, response, next) => {
  try {
    const store = await loadStore();
    const scope = request.query.scope === "key" ? "key" : "all";
    response.json({ reports: buildCoverageReport(store, request.query.connectionId, scope) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/catalog/export", async (_request, response, next) => {
  try {
    const store = await loadStore();
    response.json(exportKnowledgeCatalog(store));
  } catch (error) {
    next(error);
  }
});

app.post("/api/catalog/import", async (request, response, next) => {
  try {
    const store = await loadStore();
    const summary = importKnowledgeCatalog(store, request.body);
    await saveStore(store);
    response.status(201).json({ ok: true, ...summary });
  } catch (error) {
    next(error);
  }
});

app.get("/api/connections", async (_request, response, next) => {
  try {
    const store = await loadStore();
    response.json(store.connections.map(publicConnection));
  } catch (error) {
    next(error);
  }
});

app.post("/api/connections", async (request, response, next) => {
  try {
    const input = connectionSchema.parse(request.body);
    const store = await loadStore();
    const connection = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    store.connections.push(connection);
    await saveStore(store);
    response.status(201).json(publicConnection(connection));
  } catch (error) {
    next(error);
  }
});

app.put("/api/connections/:id", async (request, response, next) => {
  try {
    const input = connectionUpdateSchema.parse(request.body);
    const store = await loadStore();
    const connection = requireConnection(store, request.params.id);
    const nextConnection = {
      ...connection,
      ...input,
      password: input.password === undefined ? connection.password : input.password,
      updatedAt: new Date().toISOString()
    };
    Object.assign(connection, nextConnection);
    await saveStore(store);
    response.json(publicConnection(connection));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/connections/:id", async (request, response, next) => {
  try {
    const store = await loadStore();
    requireConnection(store, request.params.id);
    store.connections = store.connections.filter((item) => item.id !== request.params.id);
    store.annotations = store.annotations.filter((item) => item.connectionId !== request.params.id);
    store.audits = store.audits.filter((item) => item.connectionId !== request.params.id);
    delete store.schemaSnapshots[request.params.id];
    await saveStore(store);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/connections/:id/test", async (request, response, next) => {
  try {
    const store = await loadStore();
    const connection = requireConnection(store, request.params.id);
    await withClient(connection, (client) => client.query("SELECT 1"));
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/connections/:id/schema", async (request, response, next) => {
  try {
    const store = await loadStore();
    const connection = requireConnection(store, request.params.id);
    try {
      const rows = await introspectSchema(connection);
      const snapshot = saveSchemaSnapshot(store, connection.id, groupSchema(rows), "live");
      await saveStore(store);
      response.json({ tables: snapshot.tables, source: snapshot.source, refreshedAt: snapshot.refreshedAt });
    } catch (error) {
      const snapshot = getSchemaSnapshot(store, connection.id);
      if (!snapshot) throw error;
      response.json({
        tables: snapshot.tables,
        source: snapshot.source,
        refreshedAt: snapshot.refreshedAt,
        stale: true,
        liveError: error.message
      });
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/connections/:id/schema/import", async (request, response, next) => {
  try {
    const input = schemaImportSchema.parse(request.body);
    const store = await loadStore();
    const connection = requireConnection(store, request.params.id);
    const snapshot = saveSchemaSnapshot(store, connection.id, input.tables, "manual-import");
    await saveStore(store);
    response.status(201).json({ tables: snapshot.tables, source: snapshot.source, refreshedAt: snapshot.refreshedAt });
  } catch (error) {
    next(error);
  }
});

app.get("/api/annotations", async (request, response, next) => {
  try {
    const store = await loadStore();
    const connectionId = request.query.connectionId;
    response.json(connectionId ? store.annotations.filter((item) => item.connectionId === connectionId) : store.annotations);
  } catch (error) {
    next(error);
  }
});

app.post("/api/annotations", async (request, response, next) => {
  try {
    const input = annotationSchema.parse(request.body);
    const store = await loadStore();
    requireConnection(store, input.connectionId);
    const annotation = { id: randomUUID(), updatedAt: new Date().toISOString(), ...input };
    const warnings = validateAnnotationTarget(store, annotation);
    store.annotations.push(annotation);
    await saveStore(store);
    response.status(201).json({ ...annotation, warnings });
  } catch (error) {
    next(error);
  }
});

app.put("/api/annotations/:id", async (request, response, next) => {
  try {
    const input = annotationUpdateSchema.parse(request.body);
    const store = await loadStore();
    const annotation = requireAnnotation(store, request.params.id);
    Object.assign(annotation, input, { updatedAt: new Date().toISOString() });
    const warnings = validateAnnotationTarget(store, annotation);
    await saveStore(store);
    response.json({ ...annotation, warnings });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/annotations/:id", async (request, response, next) => {
  try {
    const store = await loadStore();
    requireAnnotation(store, request.params.id);
    store.annotations = store.annotations.filter((item) => item.id !== request.params.id);
    await saveStore(store);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/annotations/suggest", async (request, response, next) => {
  try {
    const input = annotationSuggestSchema.parse(request.body);
    const store = await loadStore();
    const connection = requireConnection(store, input.connectionId);
    const pathParts = input.targetPath.toLowerCase().split(".");
    const relatedAnnotations = store.annotations
      .filter((item) => item.connectionId === connection.id)
      .filter((item) => {
        const targetPath = item.targetPath.toLowerCase();
        return pathParts.some((part) => part && targetPath.includes(part));
      })
      .slice(0, 20);
    response.json(await suggestAnnotation(connection, input, relatedAnnotations, store));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/annotations/suggest-missing", async (request, response, next) => {
  try {
    const input = missingAnnotationSuggestSchema.parse(request.body);
    const store = await loadStore();
    const connection = requireConnection(store, input.connectionId);
    const missingPaths = missingColumnPathsForConnection(store, connection.id, input.scope).slice(0, input.limit);
    const relatedAnnotations = store.annotations.filter((annotation) => annotation.connectionId === connection.id);
    const suggestions = await Promise.all(
      missingPaths.map((targetPath) => suggestAnnotation(connection, {
        connectionId: connection.id,
        targetType: "column",
        targetPath,
        sampleValues: []
      }, relatedAnnotations, store))
    );
    const created = input.persist ? persistAnnotationSuggestions(store, connection.id, suggestions) : [];
    if (created.length) await saveStore(store);
    response.json({
      connectionId: connection.id,
      suggested: suggestions.length,
      persisted: created.length,
      suggestions,
      created
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/schema-context/annotate", async (request, response, next) => {
  try {
    const input = schemaContextAnnotateSchema.parse(request.body);
    const store = await loadStore();
    const connection = requireConnection(store, input.connectionId);
    const suggested = await suggestAnnotationsFromSchemaContext(connection, input, store);
    const normalized = suggested.annotations
      .filter((annotation) => annotation?.targetType && annotation?.targetPath && annotation?.title && annotation?.description)
      .map((annotation) => ({
        connectionId: connection.id,
        targetType: annotation.targetType,
        targetPath: annotation.targetPath,
        title: annotation.title,
        description: annotation.description,
        tags: Array.isArray(annotation.tags) ? annotation.tags.map(String) : []
      }));
    const created = input.persist ? persistAnnotationSuggestions(store, connection.id, normalized) : [];
    if (created.length) await saveStore(store);
    response.json({
      source: suggested.source,
      suggested: normalized.length,
      persisted: created.length,
      annotations: normalized,
      created
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/sql/validate", async (request, response, next) => {
  try {
    const store = await loadStore();
    const connection = request.body.connectionId
      ? requireConnection(store, request.body.connectionId)
      : { type: request.body.type && dbTypes.includes(request.body.type) ? request.body.type : "postgres" };
    const schemaTables = request.body.connectionId ? getSchemaSnapshot(store, request.body.connectionId)?.tables ?? [] : [];
    response.json(analyzeSqlPolicy(String(request.body.sql ?? ""), connection, schemaTables, Number(request.body.maxRows ?? 100)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sql/run", async (request, response, next) => {
  try {
    const store = await loadStore();
    const connection = requireConnection(store, request.body.connectionId);
    const schemaTables = getSchemaSnapshot(store, connection.id)?.tables ?? [];
    const policy = analyzeSqlPolicy(String(request.body.sql ?? ""), connection, schemaTables, Number(request.body.maxRows ?? 100));
    const sql = policy.finalSql;
    const rows = await withClient(connection, (client) => client.query(sql));
    const audit = {
      id: randomUUID(),
      connectionId: connection.id,
      sql,
      policy,
      rowCount: rows.length,
      createdAt: new Date().toISOString()
    };
    store.audits.push(audit);
    await saveStore(store);
    response.json({ sql, rows: maskRows(rows), auditId: audit.id, policy });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/sql/generate", async (request, response, next) => {
  try {
    const store = await loadStore();
    const connection = requireConnection(store, request.body.connectionId);
    const annotations = store.annotations.filter((item) => item.connectionId === connection.id);
    let schema = getSchemaSnapshot(store, connection.id)?.tables ?? [];
    try {
      schema = groupSchema(await introspectSchema(connection));
      saveSchemaSnapshot(store, connection.id, schema, "live");
      await saveStore(store);
    } catch {
      schema = getSchemaSnapshot(store, connection.id)?.tables ?? schema;
    }
    let sql = fallbackSql(String(request.body.question ?? ""), schema);
    const aiConfig = getAiConfig(store);
    if (aiConfig) {
      const openai = createOpenAIClient(aiConfig);
      const completion = await openai.chat.completions.create({
        model: aiConfig.model,
        temperature: 0,
        messages: [{ role: "user", content: buildPrompt(String(request.body.question ?? ""), connection, schema, annotations) }]
      });
      sql = completion.choices[0]?.message?.content?.replace(/```sql|```/gi, "").trim() || sql;
    }
    const policy = analyzeSqlPolicy(sql, connection, schema, 100);
    response.json({ sql: policy.finalSql, guarded: true, usedAnnotations: annotations.length, policy });
  } catch (error) {
    next(error);
  }
});

app.get("/api/audits", async (request, response, next) => {
  try {
    const store = await loadStore();
    const connectionId = request.query.connectionId;
    const audits = connectionId ? store.audits.filter((item) => item.connectionId === connectionId) : store.audits;
    response.json(audits.slice(-200).reverse());
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  const status = error.status || (error.name === "ZodError" ? 400 : 500);
  response.status(status).json({ error: error.message, details: error.errors });
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`DataIO MVP listening on http://localhost:${port}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Set PORT=another_port or stop the existing process.`);
    process.exit(1);
  }
  throw error;
});
