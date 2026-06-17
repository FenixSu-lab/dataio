# DataIO 企业数据库知识库 MVP

DataIO 用于管理多个业务系统数据库连接、浏览表字段、维护中文业务标注，并让 AI 在受控条件下生成和执行只读 SQL。

## MVP 范围

- 支持 MySQL、Postgres、SQL Server 连接信息管理。
- 连接配置支持选择具体 Node.js 驱动：MySQL 使用 `mysql2`，Postgres 使用 `pg`，SQL Server 使用 `mssql`。
- 使用只读账号连接业务库，读取表和字段元数据。
- 读取 Schema 后保存快照，实时连接失败时可回退到最近快照。
- 支持手动导入 Schema JSON，便于先沉淀知识库或在无法直连生产库时验证流程。
- 支持数据库、表、字段、枚举、常用 Join、业务口径的中文标注。
- 支持跨连接检索连接、表、字段和中文业务标注。
- Web 页面按总览、连接、表字段、知识标注、AI SQL、备份迁移分模块组织。
- 连接、标注、审计列表支持模糊搜索和分页，避免列表页无限撑开。
- 表字段浏览支持搜索、分页和折叠展示，适配 100+ 表的业务库。
- 支持“关键字段”统计范围，默认排除 id、时间戳、日志/权限类表等低价值标注对象。
- 支持统计表/关键字段标注覆盖率，暴露未标注字段样例。
- 支持导出/导入知识库 JSON，用于备份、迁移和项目交付。
- 支持基于字段名、样例值和已有标注生成中文业务说明建议。
- 支持根据覆盖率缺口批量生成待补字段标注建议，可预览或保存为标注草稿。
- 支持维护多个 OpenAI 兼容 AI 模型配置，可新增、编辑、删除，并且同一时间只激活一个。
- 支持粘贴 Django Model、DDL 或 ORM Schema，在表旁弹窗预览 AI 生成的表说明、关键字段、枚举和关联关系标注，确认后再应用。
- 表字段浏览页会直接展示已标注内容，不需要跳到单独页面查询。
- 所有 AI 调用都会附加 `config/modelops-system-prompt.md` 中的系统提示，可在该文件中维护 ModelOps 上报要求。
- 保存表/字段标注时校验目标路径是否存在于 Schema 快照，返回质量提示但不阻断录入。
- AI 生成 SQL 前注入表字段和业务标注上下文。
- SQL 执行前进行只读校验、单语句限制、自动行数限制、表名识别、未知表提示和脱敏字段提示。
- 查询结果按敏感字段名做基础脱敏，并记录审计日志。

## 暂不包含

- 复杂血缘分析。
- 全量数据质量平台。
- BI 报表平台。
- 数据中台能力。
- AI 直接写库或执行写入语句。

## 运行

```bash
npm install
npm start
```

打开 `http://localhost:3000`。

运行态连接、标注和审计记录默认写入本地 `data/catalog.json`，该文件已被 `.gitignore` 忽略，避免把连接密码提交到代码仓库。

如果所在网络或机器安装 SQL Server 驱动较慢，也可以先安装核心依赖验证 Web MVP：

```bash
npm install --omit=optional
npm start
```

需要连接真实数据库时再按需安装驱动：

```bash
npm install pg      # Postgres
npm install mysql2  # MySQL
npm install mssql   # SQL Server
```

## 验证

```bash
npm test
```

测试会使用临时 `DATAIO_STORE_PATH` 启动服务，验证连接创建、密码不回传、Schema 快照导入和缓存回退、全局目录检索、知识覆盖率、知识库导出/导入、中文标注保存、标注路径质量提示、AI 标注建议、批量待补字段建议、标注更新/删除、AI SQL 使用缓存 Schema、SQL 风控策略、写 SQL 阻断和连接删除。

### 真实数据库集成验证

如果有真实 MySQL、Postgres 或 SQL Server 只读连接，可以运行：

```bash
npm run test:db
```

未设置连接时该命令会安全跳过。连接通过 `DATAIO_TEST_CONNECTIONS` 传入 JSON 数组：

```bash
DATAIO_TEST_CONNECTIONS='[
  {
    "name": "ERP Postgres Readonly",
    "type": "postgres",
    "businessSystem": "ERP",
    "host": "127.0.0.1",
    "port": 5432,
    "database": "erp",
    "username": "readonly",
    "password": "secret",
    "expectedTable": "sale_order"
  }
]' npm run test:db
```

也可以直接复用本地 `data/catalog.json` 里的连接配置：

```powershell
$env:DATAIO_TEST_USE_CATALOG="1"
$env:DATAIO_TEST_EXPECTED_TABLE="sale_order"
npm run test:db
```

集成测试会创建连接、测试连通性、读取真实 Schema、校验只读 SQL、执行只读查询并确认审计记录。`fixtures/` 下提供 `postgres-sample.sql`、`mysql-sample.sql`、`sqlserver-sample.sql`，可用于准备样例 `sale_order` 表。

如需启用 AI SQL 生成，设置：

```bash
OPENAI_API_KEY=你的密钥
OPENAI_MODEL=gpt-4o-mini
```

未设置 `OPENAI_API_KEY` 时，系统会返回基于可用表的安全占位 SQL，便于验证完整流程。

### ModelOps 系统提示

AI 调用会自动读取并注入：

```text
config/modelops-system-prompt.md
```

如需修改 ModelOps `modelId`、上报地址或字段要求，直接编辑该文件。也可以通过环境变量覆盖路径：

```bash
DATAIO_AI_SYSTEM_PROMPT_PATH=/path/to/prompt.md
```

ModelOps 实际上报配置在：

```text
config/modelops.json
```

可配置项：

- `enabled`：是否启用上报。
- `endpoint`：ModelOps 接收地址，默认 `http://localhost:3001/api/task-runs`。
- `modelId`：固定模型 ID。
- `owner`：调用方团队或应用名称。
- `timeoutMs`：上报超时时间。
- `failureMode`：`block` 表示上报失败时阻断 AI 接口，`warn` 表示只记录告警。

也可以用环境变量覆盖：

```bash
DATAIO_MODELOPS_CONFIG_PATH=/path/to/modelops.json
DATAIO_MODELOPS_ENABLED=true
DATAIO_MODELOPS_ENDPOINT=http://localhost:3001/api/task-runs
DATAIO_MODELOPS_MODEL_ID=mdl_deepseek-deepseek-v4-pro_9fmnwH
DATAIO_MODELOPS_OWNER=DataIO
DATAIO_MODELOPS_FAILURE_MODE=block
```

运行时可在服务启动终端观察结构化日志：

- `server_ai_config`：启动时打印当前 Prompt 路径、ModelOps 配置路径、上报地址和失败策略。
- `ai_task_start` / `ai_task_success` / `ai_task_failed`：真实模型调用开始、成功、失败。
- `ai_task_skipped`：未配置 API Key，系统没有调用真实 AI，走了本地 fallback。
- `modelops_report_start` / `modelops_report_success` / `modelops_report_failed`：ModelOps 上报开始、成功、失败。

## API 概览

- `GET /api/connections`：列出连接，响应不包含密码。
- `GET /api/catalog/search?q=关键词`：跨连接检索连接、表、字段和业务标注。
- `GET /api/catalog/coverage`：统计每个连接的表/字段标注覆盖率和待补字段样例。
- `GET /api/catalog/export`：导出连接元信息、Schema 快照和业务标注，不包含密码。
- `POST /api/catalog/import`：导入知识库 JSON，只合并知识资产，不导入审计日志。
- `GET /api/settings/ai`：读取 AI 配置列表，响应不包含 API Key。
- `POST /api/settings/ai`：新增 OpenAI 兼容 AI 配置。
- `PUT /api/settings/ai/:id`：更新 AI 配置。
- `DELETE /api/settings/ai/:id`：删除 AI 配置。
- `POST /api/settings/ai/:id/activate`：激活一个 AI 配置。
- `POST /api/connections`：新增连接。
- `PUT /api/connections/:id`：更新连接元信息或密码，响应不包含密码。
- `DELETE /api/connections/:id`：删除连接，并清理相关标注和审计。
- `POST /api/connections/:id/test`：测试连接。
- `GET /api/connections/:id/schema`：读取库表字段，并保存快照；实时失败时返回缓存快照。
- `POST /api/connections/:id/schema/import`：手动导入 Schema 快照。
- `GET /api/annotations`：列出业务标注。
- `POST /api/annotations`：新增业务标注。
- `PUT /api/annotations/:id`：更新业务标注。
- `DELETE /api/annotations/:id`：删除业务标注。
- `POST /api/ai/annotations/suggest`：基于对象路径、样例值和已有标注生成中文说明建议。
- `POST /api/ai/annotations/suggest-missing`：根据未标注字段批量生成中文说明建议，可选择保存。
- `POST /api/ai/schema-context/annotate`：基于粘贴的 Django Model、DDL 或 ORM Schema 生成表字段标注。
- `POST /api/ai/sql/generate`：按问题、表字段、业务标注生成只读 SQL。
- `POST /api/sql/validate`：校验 SQL 是否只读，并返回最终 SQL、识别表、未知表、脱敏字段和风险提示。
- `POST /api/sql/run`：执行只读 SQL，自动限制行数、脱敏并审计，同时保存风控策略。
- `GET /api/audits`：查看最近审计记录。

## 企业落地注意事项

- 数据库账号必须在数据库侧授予只读权限，应用层校验不能替代数据库权限。
- 生产环境应将 `data/catalog.json` 替换为加密数据库存储，并对密码使用 KMS 或 Vault。
- SQL 只读校验应结合 SQL 解析器、数据库账号权限、代理层审计三层防护。
- 标注模型应逐步沉淀字段含义、枚举、常用 Join 和业务口径，这是 AI SQL 准确率的核心资产。
 
## Demo Data Scripts

DataIO includes two demo-data scripts:

- `scripts/reset-demo-data.js`: resets `data/catalog.json` and clears the runtime log.
- `scripts/seed-medium-demo-data.js`: resets first, then writes a medium-scale catalog dataset.

Medium-scale seed volume:

- 18 database connections
- 216 schema snapshot tables
- more than 1,500 business annotations
- 144 SQL audit samples
- 3 AI profiles

Run locally:

```powershell
npm run reset:demo
npm run seed:demo
```

Run inside Docker Compose:

```powershell
docker compose exec -T dataio npm run reset:demo
docker compose exec -T dataio npm run seed:demo
```

`seed:demo` overwrites the demo catalog file so screenshots start from a known medium-scale dataset.
