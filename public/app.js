let selectedConnectionId = null;
let activeModule = "dashboard";
let schemaTables = [];
let schemaPage = 1;
let connectionRows = [];
let annotationRows = [];
let auditRows = [];
let connectionPage = 1;
let annotationPage = 1;
let auditPage = 1;
const listPageSize = 10;
const driverOptions = {
  mysql: [{ value: "mysql2", label: "MySQL · mysql2" }],
  postgres: [{ value: "pg", label: "Postgres · pg" }],
  sqlserver: [{ value: "mssql", label: "SQL Server · mssql" }]
};
const defaultPorts = { mysql: 3306, postgres: 5432, sqlserver: 1433 };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : { error: `接口 ${path} 返回了非 JSON 内容，请确认服务已重启且接口存在`, raw: (await response.text()).slice(0, 160) };
  if (!response.ok) throw new Error(data.error || "请求失败");
  if (!contentType.includes("application/json")) throw new Error(data.error);
  return data;
}

function formJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function syncConnectionDriver(type, selectedDriver = null) {
  const form = $("#connection-form");
  const driverSelect = form.elements.driver;
  const options = driverOptions[type] ?? [];
  driverSelect.innerHTML = options.map((option) => `<option value="${option.value}">${option.label}</option>`).join("");
  driverSelect.value = selectedDriver && options.some((option) => option.value === selectedDriver)
    ? selectedDriver
    : options[0]?.value ?? "";
  if (!form.elements.port.value || Object.values(defaultPorts).includes(Number(form.elements.port.value))) {
    form.elements.port.value = defaultPorts[type] ?? "";
  }
}

function renderJson(target, data) {
  target.textContent = JSON.stringify(data, null, 2);
}

function fuzzyIncludes(row, query) {
  return JSON.stringify(row).toLowerCase().includes(query.trim().toLowerCase());
}

function paginateRows(rows, query, page) {
  const filtered = query ? rows.filter((row) => fuzzyIncludes(row, query)) : rows;
  const totalPages = Math.max(1, Math.ceil(filtered.length / listPageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  return {
    rows: filtered.slice((safePage - 1) * listPageSize, safePage * listPageSize),
    page: safePage,
    totalPages,
    total: filtered.length
  };
}

function switchModule(moduleName) {
  activeModule = moduleName;
  $$("[data-module]").forEach((section) => section.classList.toggle("active", section.dataset.module === moduleName));
  $$("[data-module-tab]").forEach((tab) => tab.classList.toggle("active", tab.dataset.moduleTab === moduleName));
}

function renderPolicy(policy) {
  const container = $("#sql-policy");
  if (!policy) {
    container.innerHTML = "";
    return;
  }
  container.innerHTML = `
    <strong>SQL 风控：${policy.mode}</strong>
    <p>最终执行：<span class="columns">${policy.finalSql}</span></p>
    <p>识别表：${policy.referencedTables.length ? policy.referencedTables.join(", ") : "未识别"}</p>
    <p>脱敏字段：${policy.maskedColumns.length ? policy.maskedColumns.slice(0, 10).join(", ") : "无"}</p>
    ${policy.warnings.length ? `<ul>${policy.warnings.map((warning) => `<li>${warning}</li>`).join("")}</ul>` : "<p>无额外风险提示</p>"}
  `;
}

function fillAnnotationForm(targetType, targetPath, title = "") {
  const form = $("#annotation-form");
  form.elements.targetType.value = targetType;
  form.elements.targetPath.value = targetPath;
  if (title) form.elements.title.value = title;
  switchModule("annotations");
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function currentSchemaRows() {
  const query = $("#schema-filter").value.trim().toLowerCase();
  if (!query) return schemaTables;
  return schemaTables.filter((table) => {
    const tablePath = `${table.schema}.${table.table}`.toLowerCase();
    return tablePath.includes(query) || table.columns.some((column) => `${column.name} ${column.type}`.toLowerCase().includes(query));
  });
}

function annotationsForPath(path, targetType) {
  return annotationRows.filter((annotation) => annotation.targetType === targetType && annotation.targetPath.toLowerCase() === path.toLowerCase());
}

function annotationBadges(path, targetType) {
  const matches = annotationsForPath(path, targetType);
  if (!matches.length) return `<span class="empty-note">未标注</span>`;
  return matches.map((annotation) => `<span class="annotation-note">${annotation.title}：${annotation.description}</span>`).join("");
}

function renderSchema() {
  const container = $("#schema");
  const pageSize = Number($("#schema-page-size").value);
  const rows = currentSchemaRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  schemaPage = Math.min(Math.max(1, schemaPage), totalPages);
  const pageRows = rows.slice((schemaPage - 1) * pageSize, schemaPage * pageSize);
  $("#schema-meta").textContent = `${$("#schema-meta").dataset.baseText || ""} · 当前显示 ${pageRows.length}/${rows.length} 张表 · 第 ${schemaPage}/${totalPages} 页`;
  container.innerHTML = "";
  for (const table of pageRows) {
    const item = document.createElement("details");
    item.className = "item";
    item.innerHTML = `
      <summary>
        <strong>${table.schema}.${table.table}</strong>
        <span class="hint">${table.columns.length} 个字段</span>
      </summary>
      <div class="actions">
        <button class="secondary" data-annotate-table="${table.schema}.${table.table}">标注表说明</button>
        <button data-ai-table="${table.schema}.${table.table}">AI 标注</button>
      </div>
      <div class="inline-annotation">${annotationBadges(`${table.schema}.${table.table}`, "table")}</div>
      <div class="columns">
        ${table.columns.map((column) => `
          <div class="column-row">
            <div>
              <strong>${column.name}</strong> <span>${column.type}</span>
              <div class="inline-annotation">${annotationBadges(`${table.schema}.${table.table}.${column.name}`, "column")}</div>
            </div>
            <button class="secondary mini" data-annotate-column="${table.schema}.${table.table}.${column.name}">标注关键字段</button>
          </div>
        `).join("")}
      </div>
    `;
    container.appendChild(item);
  }
  if (!pageRows.length) container.innerHTML = `<p class="hint">没有匹配的表或字段。</p>`;
}

async function loadConnections() {
  connectionRows = await api("/api/connections");
  renderConnections();
}

function renderConnections() {
  const page = paginateRows(connectionRows, $("#connection-filter").value, connectionPage);
  connectionPage = page.page;
  const container = $("#connections");
  container.innerHTML = "";
  $("#connection-page-info").textContent = `共 ${page.total} 条连接 · 第 ${page.page}/${page.totalPages} 页`;
  for (const connection of page.rows) {
    const item = document.createElement("div");
    item.className = `item ${connection.id === selectedConnectionId ? "active" : ""}`;
    item.innerHTML = `
      <strong>${connection.name}</strong>
      <p class="hint">${connection.businessSystem} · ${connection.type} · ${connection.host}:${connection.port}/${connection.database}</p>
      <button data-select="${connection.id}">选择</button>
      <button class="secondary" data-edit-connection="${connection.id}">编辑</button>
      <button class="secondary" data-test="${connection.id}">测试</button>
      <button class="secondary" data-schema="${connection.id}">读取表字段</button>
      <button class="danger" data-delete-connection="${connection.id}">删除</button>
    `;
    container.appendChild(item);
  }
}

async function loadAnnotations() {
  const suffix = selectedConnectionId ? `?connectionId=${selectedConnectionId}` : "";
  annotationRows = await api(`/api/annotations${suffix}`);
  renderAnnotations();
}

function renderAnnotations() {
  const page = paginateRows(annotationRows, $("#annotation-filter").value, annotationPage);
  annotationPage = page.page;
  const container = $("#annotations");
  container.innerHTML = "";
  $("#annotation-page-info").textContent = `共 ${page.total} 条标注 · 第 ${page.page}/${page.totalPages} 页`;
  for (const annotation of page.rows) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <strong>${annotation.title}</strong>
      <p>${annotation.description}</p>
      <p class="hint">${annotation.targetType} · ${annotation.targetPath} · ${annotation.tags.join(", ")}</p>
      <button class="secondary" data-edit-annotation="${annotation.id}">编辑说明</button>
      <button class="danger" data-delete-annotation="${annotation.id}">删除</button>
    `;
    container.appendChild(item);
  }
}

async function loadAudits() {
  const suffix = selectedConnectionId ? `?connectionId=${selectedConnectionId}` : "";
  auditRows = await api(`/api/audits${suffix}`);
  renderAudits();
}

function renderAudits() {
  const page = paginateRows(auditRows, $("#audit-filter").value, auditPage);
  auditPage = page.page;
  const container = $("#audits");
  container.innerHTML = "";
  $("#audit-page-info").textContent = `共 ${page.total} 条审计 · 第 ${page.page}/${page.totalPages} 页`;
  for (const audit of page.rows) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <strong>${audit.rowCount} 行 · ${new Date(audit.createdAt).toLocaleString()}</strong>
      <p class="columns">${audit.sql}</p>
    `;
    container.appendChild(item);
  }
}

async function searchCatalog() {
  const query = $("#catalog-query").value.trim();
  const data = await api(`/api/catalog/search?q=${encodeURIComponent(query)}`);
  const container = $("#catalog-results");
  container.innerHTML = "";
  for (const result of data.results) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <strong>${result.type} · ${result.title}</strong>
      <p>${result.description}</p>
      <p class="hint">${result.connection ? `${result.connection.businessSystem} · ${result.connection.name} · ` : ""}${result.path}</p>
      ${result.type === "table" ? `<button class="secondary" data-search-annotate-table="${result.path}">标注表</button>` : ""}
      ${result.type === "column" ? `<button class="secondary" data-search-annotate-column="${result.path}">标注字段</button>` : ""}
    `;
    container.appendChild(item);
  }
  if (!data.results.length) {
    container.innerHTML = `<p class="hint">没有匹配结果。可以先读取或导入 Schema 快照，再补充业务标注。</p>`;
  }
}

async function loadCoverage() {
  const scope = $("#coverage-scope").value;
  const data = await api(`/api/catalog/coverage?scope=${scope}`);
  const container = $("#coverage");
  container.innerHTML = "";
  for (const report of data.reports) {
    const item = document.createElement("div");
    item.className = "item";
    item.innerHTML = `
      <strong>${report.connection.businessSystem} · ${report.connection.name}</strong>
      <p>表说明 ${report.annotated.tables}/${report.totals.tables}（${report.coverage.tables}%） · 字段说明 ${report.annotated.columns}/${report.totals.columns}（${report.coverage.columns}%）</p>
      <p class="hint">统计范围：${report.scope === "key" ? "关键字段" : "全部字段"} · 原始 ${report.totals.rawTables} 表 / ${report.totals.rawColumns} 字段 · Schema ${report.schemaSource ?? "未读取"}</p>
      <p class="hint">枚举 ${report.totals.enumAnnotations} · Join ${report.totals.joinAnnotations} · 口径 ${report.totals.metricAnnotations}</p>
      <div class="actions">
        <button class="secondary" data-suggest-missing="${report.connection.id}">生成待补建议</button>
        <button data-persist-missing="${report.connection.id}">保存前 10 个建议</button>
      </div>
      ${report.missing.columns.length ? `<details><summary>待补字段样例</summary><div class="columns">${report.missing.columns.slice(0, 20).join("<br>")}</div></details>` : "<p class=\"hint\">当前统计范围内字段说明已覆盖。</p>"}
    `;
    container.appendChild(item);
  }
  if (!data.reports.length) {
    container.innerHTML = `<p class="hint">暂无连接。添加连接并读取或导入 Schema 后可查看覆盖率。</p>`;
  }
}

async function refreshKnowledgeViews() {
  await loadConnections();
  await loadAnnotations();
  await loadAudits();
  await loadCoverage();
  await loadAiSettings();
}

async function loadAiSettings() {
  const settings = await api("/api/settings/ai");
  $("#ai-settings-status").textContent = JSON.stringify(settings, null, 2);
  $("#ai-system-prompt-status").textContent = settings.systemPrompt?.configured
    ? `ModelOps 系统提示已启用：${settings.systemPrompt.path}`
    : "ModelOps 系统提示未配置。";
  const container = $("#ai-profiles");
  container.innerHTML = "";
  for (const profile of settings.profiles) {
    const item = document.createElement("div");
    item.className = `item ${profile.id === settings.activeProfileId ? "active" : ""}`;
    item.innerHTML = `
      <strong>${profile.name}</strong>
      <p class="hint">${profile.provider} · ${profile.baseUrl} · ${profile.model} · ${profile.hasApiKey ? "已配置 Key" : "未配置 Key"}</p>
      <button data-activate-ai="${profile.id}">设为当前</button>
      <button class="secondary" data-edit-ai="${profile.id}">编辑</button>
      <button class="danger" data-delete-ai="${profile.id}">删除</button>
    `;
    container.appendChild(item);
  }
}

async function loadSchema(connectionId) {
  selectedConnectionId = connectionId;
  const data = await api(`/api/connections/${connectionId}/schema`);
  schemaTables = data.tables;
  annotationRows = await api(`/api/annotations?connectionId=${connectionId}`);
  schemaPage = 1;
  const baseText = `Schema 来源：${data.source}${data.stale ? "（实时连接失败，使用缓存）" : ""}${data.refreshedAt ? ` · ${new Date(data.refreshedAt).toLocaleString()}` : ""}`;
  $("#schema-meta").dataset.baseText = baseText;
  renderSchema();
  await refreshKnowledgeViews();
  switchModule("schema");
}

$$("[data-module-tab]").forEach((tab) => {
  tab.addEventListener("click", () => switchModule(tab.dataset.moduleTab));
});

syncConnectionDriver($("#connection-form").elements.type.value);

$("#schema-filter").addEventListener("input", () => {
  schemaPage = 1;
  renderSchema();
});

$("#schema-page-size").addEventListener("change", () => {
  schemaPage = 1;
  renderSchema();
});

$("#schema-prev").addEventListener("click", () => {
  schemaPage -= 1;
  renderSchema();
});

$("#schema-next").addEventListener("click", () => {
  schemaPage += 1;
  renderSchema();
});

$("#connection-filter").addEventListener("input", () => {
  connectionPage = 1;
  renderConnections();
});

$("#connection-prev").addEventListener("click", () => {
  connectionPage -= 1;
  renderConnections();
});

$("#connection-next").addEventListener("click", () => {
  connectionPage += 1;
  renderConnections();
});

$("#annotation-filter").addEventListener("input", () => {
  annotationPage = 1;
  renderAnnotations();
});

$("#annotation-prev").addEventListener("click", () => {
  annotationPage -= 1;
  renderAnnotations();
});

$("#annotation-next").addEventListener("click", () => {
  annotationPage += 1;
  renderAnnotations();
});

$("#audit-filter").addEventListener("input", () => {
  auditPage = 1;
  renderAudits();
});

$("#audit-prev").addEventListener("click", () => {
  auditPage -= 1;
  renderAudits();
});

$("#audit-next").addEventListener("click", () => {
  auditPage += 1;
  renderAudits();
});

$("#import-schema").addEventListener("click", async () => {
  if (!selectedConnectionId) return alert("请先选择一个数据库连接");
  try {
    const body = JSON.parse($("#schema-import").value);
    const data = await api(`/api/connections/${selectedConnectionId}/schema/import`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    $("#schema-import").value = "";
    renderJson($("#result"), data);
    await loadSchema(selectedConnectionId);
  } catch (error) {
    alert(error.message);
  }
});

$("#schema").addEventListener("click", (event) => {
  const tablePath = event.target.dataset.annotateTable;
  const columnPath = event.target.dataset.annotateColumn;
  const aiTablePath = event.target.dataset.aiTable;
  if (tablePath) fillAnnotationForm("table", tablePath, tablePath.split(".").at(-1));
  if (columnPath) fillAnnotationForm("column", columnPath, columnPath.split(".").at(-1));
  if (aiTablePath) {
    $("#schema-context-target").value = aiTablePath;
    $("#schema-context").value = "";
    $("#schema-context-preview-result").textContent = "";
    $("#schema-ai-dialog").showModal();
  }
});

async function annotateFromSchemaContext(persist) {
  if (!selectedConnectionId) return alert("请先选择一个数据库连接");
  const targetPath = $("#schema-context-target").value.trim();
  const context = $("#schema-context").value.trim();
  if (!targetPath || !context) return alert("请填写目标表路径并粘贴模型/Schema 内容");
  const data = await api("/api/ai/schema-context/annotate", {
    method: "POST",
    body: JSON.stringify({ connectionId: selectedConnectionId, targetPath, context, persist })
  });
  renderJson($("#schema-context-preview-result"), data);
  renderJson($("#result"), data);
  if (persist) {
    await loadAnnotations();
    await loadCoverage();
    if (selectedConnectionId) await loadSchema(selectedConnectionId);
    $("#schema-ai-dialog").close();
  }
}

$("#schema-context-preview").addEventListener("click", async () => {
  try {
    await annotateFromSchemaContext(false);
  } catch (error) {
    alert(error.message);
  }
});

$("#schema-context-save").addEventListener("click", async () => {
  try {
    await annotateFromSchemaContext(true);
  } catch (error) {
    alert(error.message);
  }
});

$("#catalog-search").addEventListener("click", async () => {
  try {
    await searchCatalog();
  } catch (error) {
    alert(error.message);
  }
});

$("#catalog-query").addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  try {
    await searchCatalog();
  } catch (error) {
    alert(error.message);
  }
});

$("#catalog-results").addEventListener("click", (event) => {
  const tablePath = event.target.dataset.searchAnnotateTable;
  const columnPath = event.target.dataset.searchAnnotateColumn;
  if (tablePath) fillAnnotationForm("table", tablePath, tablePath.split(".").at(-1));
  if (columnPath) fillAnnotationForm("column", columnPath, columnPath.split(".").at(-1));
});

$("#connection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = formJson(event.target);
  body.port = Number(body.port);
  try {
    const connection = await api("/api/connections", { method: "POST", body: JSON.stringify(body) });
    selectedConnectionId = connection.id;
    event.target.reset();
    await loadConnections();
  } catch (error) {
    alert(error.message);
  }
});

$("#connection-form").elements.type.addEventListener("change", (event) => {
  syncConnectionDriver(event.target.value);
});

$("#annotation-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!selectedConnectionId) return alert("请先选择一个数据库连接");
  const body = formJson(event.target);
  body.connectionId = selectedConnectionId;
  body.tags = body.tags ? body.tags.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
  try {
    const annotation = await api("/api/annotations", { method: "POST", body: JSON.stringify(body) });
    renderJson($("#result"), annotation);
    event.target.reset();
    await loadAnnotations();
    await loadCoverage();
  } catch (error) {
    alert(error.message);
  }
});

$("#suggest-annotation").addEventListener("click", async () => {
  if (!selectedConnectionId) return alert("请先选择一个数据库连接");
  const form = $("#annotation-form");
  const body = formJson(form);
  if (!body.targetPath) return alert("请先填写标注路径");
  body.connectionId = selectedConnectionId;
  try {
    const suggestion = await api("/api/ai/annotations/suggest", {
      method: "POST",
      body: JSON.stringify(body)
    });
    form.elements.title.value = suggestion.title;
    form.elements.description.value = suggestion.description;
    form.elements.tags.value = suggestion.tags.join(", ");
    renderJson($("#result"), suggestion);
  } catch (error) {
    alert(error.message);
  }
});

$("#ai-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = formJson(event.target);
  if (!body.id) delete body.id;
  try {
    const path = body.id ? `/api/settings/ai/${body.id}` : "/api/settings/ai";
    const method = body.id ? "PUT" : "POST";
    const settings = await api(path, { method, body: JSON.stringify(body) });
    renderJson($("#ai-settings-status"), settings);
    event.target.elements.apiKey.value = "";
    event.target.elements.id.value = "";
    await loadAiSettings();
  } catch (error) {
    alert(error.message);
  }
});

$("#reset-ai-form").addEventListener("click", () => {
  const form = $("#ai-settings-form");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "DeepSeek";
  form.elements.provider.value = "deepseek";
  form.elements.baseUrl.value = "https://api.deepseek.com";
  form.elements.model.value = "deepseek-chat";
});

$("#ai-profiles").addEventListener("click", async (event) => {
  const activateId = event.target.dataset.activateAi;
  const editId = event.target.dataset.editAi;
  const deleteId = event.target.dataset.deleteAi;
  try {
    if (activateId) {
      await api(`/api/settings/ai/${activateId}/activate`, { method: "POST" });
      await loadAiSettings();
    }
    if (editId) {
      const settings = await api("/api/settings/ai");
      const profile = settings.profiles.find((item) => item.id === editId);
      const form = $("#ai-settings-form");
      form.elements.id.value = profile.id;
      form.elements.name.value = profile.name;
      form.elements.provider.value = profile.provider;
      form.elements.baseUrl.value = profile.baseUrl;
      form.elements.model.value = profile.model;
      form.elements.apiKey.value = "";
    }
    if (deleteId && confirm("确定删除这个 AI 配置？")) {
      await api(`/api/settings/ai/${deleteId}`, { method: "DELETE" });
      await loadAiSettings();
    }
  } catch (error) {
    alert(error.message);
  }
});

$("#connections").addEventListener("click", async (event) => {
  const id = event.target.dataset.select || event.target.dataset.editConnection || event.target.dataset.test || event.target.dataset.schema || event.target.dataset.deleteConnection;
  if (!id) return;
  try {
    if (event.target.dataset.select) {
      selectedConnectionId = id;
      await refreshKnowledgeViews();
    }
    if (event.target.dataset.editConnection) {
      const connections = await api("/api/connections");
      const connection = connections.find((item) => item.id === id);
      if (!connection) return alert("连接不存在");
      const name = prompt("连接名称", connection.name);
      if (!name) return;
      const type = prompt("Database type: mysql / postgres / sqlserver", connection.type);
      if (!type || !driverOptions[type]) return alert("Unsupported database type");
      const driver = prompt(`Driver: ${driverOptions[type].map((option) => option.value).join(" / ")}`, connection.driver || driverOptions[type][0].value);
      if (!driverOptions[type].some((option) => option.value === driver)) return alert("Unsupported driver");
      const host = prompt("Host", connection.host);
      if (!host) return;
      const port = Number(prompt("Port", connection.port));
      if (!port) return;
      const database = prompt("Database", connection.database);
      if (!database) return;
      const note = prompt("备注", connection.note ?? "") ?? "";
      await api(`/api/connections/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name, type, driver, host, port, database, note })
      });
      await refreshKnowledgeViews();
    }
    if (event.target.dataset.test) {
      alert(JSON.stringify(await api(`/api/connections/${id}/test`, { method: "POST" })));
    }
    if (event.target.dataset.schema) {
      await loadSchema(id);
    }
    if (event.target.dataset.deleteConnection && confirm("删除连接会同时删除相关标注和审计，确定继续？")) {
      await api(`/api/connections/${id}`, { method: "DELETE" });
      if (selectedConnectionId === id) selectedConnectionId = null;
      await refreshKnowledgeViews();
    }
  } catch (error) {
    alert(error.message);
  }
});

$("#annotations").addEventListener("click", async (event) => {
  const editId = event.target.dataset.editAnnotation;
  const deleteId = event.target.dataset.deleteAnnotation;
  try {
    if (editId) {
      const description = prompt("输入新的业务说明");
      if (!description) return;
      const annotation = await api(`/api/annotations/${editId}`, { method: "PUT", body: JSON.stringify({ description }) });
      renderJson($("#result"), annotation);
      await loadAnnotations();
      await loadCoverage();
    }
    if (deleteId && confirm("确定删除这条标注？")) {
      await api(`/api/annotations/${deleteId}`, { method: "DELETE" });
      await loadAnnotations();
      await loadCoverage();
    }
  } catch (error) {
    alert(error.message);
  }
});

$("#generate").addEventListener("click", async () => {
  if (!selectedConnectionId) return alert("请先选择一个数据库连接");
  try {
    const data = await api("/api/ai/sql/generate", {
      method: "POST",
      body: JSON.stringify({ connectionId: selectedConnectionId, question: $("#question").value })
    });
    $("#sql").value = data.sql;
    renderPolicy(data.policy);
    renderJson($("#result"), data);
  } catch (error) {
    alert(error.message);
  }
});

$("#validate").addEventListener("click", async () => {
  try {
    const data = await api("/api/sql/validate", {
      method: "POST",
      body: JSON.stringify({ connectionId: selectedConnectionId, sql: $("#sql").value })
    });
    renderPolicy(data);
    renderJson($("#result"), data);
  } catch (error) {
    alert(error.message);
  }
});

$("#run").addEventListener("click", async () => {
  if (!selectedConnectionId) return alert("请先选择一个数据库连接");
  try {
    const data = await api("/api/sql/run", {
      method: "POST",
      body: JSON.stringify({ connectionId: selectedConnectionId, sql: $("#sql").value, maxRows: 100 })
    });
    renderPolicy(data.policy);
    renderJson($("#result"), data);
    await loadAudits();
  } catch (error) {
    alert(error.message);
  }
});

$("#refresh").addEventListener("click", async () => {
  await refreshKnowledgeViews();
  if (activeModule === "schema") renderSchema();
});

$("#coverage-scope").addEventListener("change", loadCoverage);
$("#refresh-coverage").addEventListener("click", loadCoverage);

$("#coverage").addEventListener("click", async (event) => {
  const previewId = event.target.dataset.suggestMissing;
  const persistId = event.target.dataset.persistMissing;
  const connectionId = previewId || persistId;
  if (!connectionId) return;
  try {
    const data = await api("/api/ai/annotations/suggest-missing", {
      method: "POST",
      body: JSON.stringify({ connectionId, limit: 10, persist: Boolean(persistId), scope: $("#coverage-scope").value })
    });
    renderJson($("#result"), data);
    if (persistId) await refreshKnowledgeViews();
  } catch (error) {
    alert(error.message);
  }
});

$("#export-catalog").addEventListener("click", async () => {
  try {
    const data = await api("/api/catalog/export");
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `dataio-knowledge-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
    renderJson($("#result"), data);
  } catch (error) {
    alert(error.message);
  }
});

$("#import-catalog").addEventListener("click", async () => {
  try {
    const payload = JSON.parse($("#catalog-import-json").value);
    const summary = await api("/api/catalog/import", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    $("#catalog-import-json").value = "";
    renderJson($("#result"), summary);
    await refreshKnowledgeViews();
  } catch (error) {
    alert(error.message);
  }
});

await refreshKnowledgeViews();
