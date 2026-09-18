# 🧠 TAgent — AI 办公协作助手

> 面向非技术用户的可视化多 Agent 办公协作平台。目标是把 Agent 的分工、执行、成本、治理和会话分支变成可理解、可管理、可回溯的产品体验。

## 当前状态

2026-09-19：G盘本机版本已更新并运行，主项目与三个独立开源工具已交付GitHub。最新修复补齐引用前提后的职责扩大检查，并让有依据的内容问题保留原有一次修订机会，避免被另一条无效核对记录阻断；305项相关回归、Core类型/lint及构建通过，原数据和模型配置不变。功能交付范围见 [目标核对](./docs/release-readiness.md#当前目标交付核对2026-09-18)。

最新追加$1测试授权内共34次调用，保守估算$0.11053896，无本批未知用量，当前没有在途付费请求。修复后完整项目任务已返回排期和报告，但风险/验收措辞仍需人工审核；默认Flash未切换，不把模型自评或更强模型的单次对照当作事实认证。完整证据、费用和保留限制见 [核心收尾](./docs/release-readiness.md#限额核心复测与收尾2026-09-19)，其中各日期的测试数量只代表对应版本。

TAgent 现在已经不是单纯的概念文档，仓库中已有一套可运行的 TypeScript monorepo 原型：

当前默认 DeepSeek 模型为 `deepseek-flash`，显式配置不覆盖；核对失败保留原稿。研究/项目回复仍存在语义质量限制，暂不宣称所有办公任务已达生产质量。

| 包 | 当前能力 |
|----|---------|
| `packages/tagent-ai` | LLM 抽象层，支持 Anthropic / OpenAI 风格 Provider、工具调用、流式事件类型和成本追踪 |
| `packages/tagent-core` | Agent Loop、Orchestrator、多 Agent 通信协议、治理引擎、Agent Card/Pool、Trace、Skills/MCP 注册、浏览器/搜索/URL 工具、Heartbeat/Cron/Metrics 原型 |
| `packages/tagent-server` | Hono App Server，提供 Workspace/Session、Agent Orchestrate、SSE、WebSocket、Skills、Agents、MCP、治理事件、团队导入导出等 API |
| `packages/tagent-web` | Next.js 前端主界面，包含聊天入口、实时工作流看板、推理时间线、Session Fork/Diff，以及 Skills/Agents/MCP/Governance 管理页面 |
| `packages/tagent-desktop` | Electron 桌面端原型/规划中 |

## 已有特性

- **办公任务入口**：首页提供六类任务准备表单和当前工作空间的近期对话。先核对材料与交付要求，再预览、填入草稿、手动发送；默认保留已有草稿，不自动调用模型。支持粘贴文本，数据任务另支持有界表格文件预览，不是通用附件库或六角色交付能力认证，边界与验收见 [任务准备](./docs/task-workbench.md)。
- **多 Agent 编排原型**：主 Orchestrator 可做任务分解、调度常驻/任务 Agent，并汇总结果。
- **表格导入、计算与 Excel 下载**：数据任务支持 XLSX/CSV/TSV 文件读取预览，核对工作表与行列范围后追加到材料；预览不保存原文件、不调用模型。数据 Agent 使用用户确认的文本进行精确分组统计和变化率比较，异常值不静默丢弃，原文范围与计算回执随任务保存。回复下方可核对原文，手动下载全部结果、比较与口径，保留精度和未计算状态。查看/导出不重跑任务、不执行公式；已有绑定不覆盖。尚不包含通用附件存储、图表或完整数据交付认证，限制见 [数据分析](./docs/data-analysis.md)。
- **调研证据核对**：结论绑定读取过的原文段落，经过引用校验、模型辅助核对和最多一次修订；来源与核对记录随会话保存，可在回复下方展开查看。这是支持性检查，不等于独立事实核查，真实搜索与调研质量仍在验收。
- **办公交付核对**：非联网调研的成功草稿接入逐段核对，程序复算已登记长度/算式，模型辅助检查材料与交付要求。预算内最多修订一次；部分字段无效时保留有效检查和具体原因，不标成成功。原稿、核对回执和已知用量随任务保存，取消/重启可回查已落盘内容，不自动重跑。记录默认折叠；不是独立金标准评测，边界见 [办公交付核对](./docs/office-delivery.md)。
- **回复下载为 Word**：已结束的单条回复可手动下载为可编辑 DOCX，保留标题、列表层级、表格、链接、脚注及已有核对/来源记录；失败与未保存状态不改写为成功。转换在浏览器本地完成，不新增模型或联网调用。正文同步修复嵌套列表与表格尾列丢失，范围与验收见 [回复与 Word 交付](./docs/report-export.md)。
- **Agent 评分与证据**：大厅保留七维雷达、免费配置检查和已保存任务复核。八题受控办公实跑已接入预览、费用/外发确认、进度、取消与历史；只有完整且保存成功、配置仍匹配的成绩用于雷达，并标注“固定材料题”。打开页面不调用模型，部分失败不生成整套成绩，重启不自动重跑。真实模型和办公质量仍未验收，不能把配置或固定材料成绩当作全能能力认证；边界见 [Agent 评测](./docs/agent-benchmark.md)。
- **实时可视化**：前端消费 SSE 事件，展示任务拆解、Agent 生成、工具调用、治理事件和最终输出。
- **长任务工作流**：侧栏收起时卸载内部视图，长分组和日志按可见区域渲染；事件可搜索、首尾定位并恢复阅读位置。架构保留完整关系，流动效果批量绘制。219节点本机固定样例的持续动画和平移接近60fps，运行中大图增量和跨设备性能仍待验收，范围见 [长任务工作流验收](./docs/workflow-performance.md)。
- **治理与执行确认**：支持规则检查、工具白名单和逐次确认；超时、取消、缺少确认处理器或决定保存失败都不授予许可。治理页从同一组任务事件读取决定、来源和已知成本，兼容旧版历史，支持筛选与分页。模式、回查与边界见 [工具确认与治理记录](./docs/governance-approval.md)。
- **执行记录回查**：历史任务展开后按需分页，可筛选协作者/行为并查看事件明细。统一事件按run写入可重建的JSONL索引，校验归属、字节与游标；索引故障不阻断最终报告。工作流图继续使用完整事件。当前不是全量会话载荷分页，边界见 [执行记录与索引](./docs/trace-history.md)。
- **Skills 与 MCP 管理**：提供 Skills CRUD、AI 建议草稿、Agent 绑定、MCP Server 配置管理。Skill URL 导入按指定 GitHub 目录/版本读取 `SKILL.md` 和附属资源，多技能仓库先选择；预览不保存，读取失败不生成占位草稿。确认后保留来源快照和文件，已绑定的文本资源可在工具白名单允许时通过 `read_skill_file` 按需读取；脚本不自动执行，超限附件明确标为未导入。MCP 已接入官方 SDK 握手和工具列表，配置原子保存、认证信息脱敏；stdio 须单独授权任务调用，测试按钮不会启动进程。MCP 导入已读取真实 JSON/README 配置、npm 版本与命令入口、官方 Registry 的包和远程服务配置；多配置先选择，目录和凭据等未填写时阻止保存。部分包仍需人工核对启动参数，GitHub 限流会明确报错。
- **Session 分支**：支持新建、完整 Fork、摘要 Fork、树形侧栏、分支 Diff 和结论引用回主线。
- **运行时基础设施**：已有 Trace JSONL、PostgreSQL/File persistence、Redis cache、Heartbeat、Cron、Metrics、团队导出/导入等能力。
- **离线数据备份**：文件模式可按清单与哈希备份完整 `.tagent/`，只恢复到新目录并撤销旧 MCP 执行授权；不自动停服、不上传、不加密，操作前须确认离线与隐私范围。说明与限制见 [备份与恢复](./docs/data-backup.md)。

## 规划增强

- **递归裂变深化**：继续完善所有 Agent 可创建子 Agent、子 Agent 逐级上交结果的能力边界。
- **浏览器工具增强**：Phase 1/2 优先做无状态公开网页抓取；复杂登录态与交互式自动化后移。
- **治理可解释性**：把治理事件进一步做成面向非技术用户的决策链回溯。
- **Session 引用式合并**：MVP 采用“结论摘取引用 + Diff 视图”，不做自动对话级 Merge。
- **渐进式安全**：Phase 1/2 使用目录白名单和工具权限控制；Docker 沙箱作为后续增强。

## 架构

```text
packages/
  tagent-ai/        -> LLM 抽象层（Anthropic / OpenAI / DeepSeek 兼容 + 成本追踪）
  tagent-core/      -> Agent Runtime（Loop / Orchestrator / Governance / Protocol）
  tagent-server/    -> App Server（Hono + SSE + WebSocket API）
  tagent-web/       -> Next.js 16 前端（React Flow / Framer Motion / Radix UI）
  tagent-desktop/   -> Electron 桌面端（原型/规划中）
```

## 快速开始

当前这台 Windows 电脑已选择在 `G:\tagent` 运行本机版。日常使用 `pnpm local:start` / `pnpm local:stop`，访问 `http://127.0.0.1:3000/`；更新代码先停止，再执行 `pnpm local:build`。配置、数据、日志与访问边界见 [G 盘本机运行](./docs/local-windows.md)。下面保留通用开发环境配置步骤。

### 前置条件

- **Node.js** >= 22.13（当前正文解析依赖要求；本地已使用 Node 24 验证）
- **pnpm** 10.12.1（与 `packageManager` 和锁文件保持一致）
- **Docker Desktop** 可选：仅在需要本地 PostgreSQL / Redis 时使用

### 1. 安装依赖

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

### 2. 配置环境变量

后端需要至少配置一个模型 API Key：

```bash
cp packages/tagent-server/.env.example packages/tagent-server/.env
```

在 `.env` 中填入以下任一项，并取消该行开头的 `#` 注释：

```bash
DEEPSEEK_API_KEY=...
# 或
ANTHROPIC_API_KEY=...
# 或
OPENAI_API_KEY=...
```

多组密钥同时存在时，可用 `TAGENT_LLM_PROVIDER=deepseek|anthropic|openai` 选择；`TAGENT_LLM_MODEL` 指定模型，`DEEPSEEK_BASE_URL` / `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` 可指定相应兼容服务地址。部署环境变量优先于 `.env`。`TAGENT_LLM_TIMEOUT_MS` 默认 60000，覆盖单次请求直到完整正文或流式响应结束，而不只是建立连接；可配置范围为 1000–300000 毫秒。

模型连接、DNS/证书、认证、限流/余额与接口格式错误会显示分类原因和处理建议，不回显服务商原始错误正文。默认不进行 SDK 自动重试；超时和用户取消分别标记，综合失败时保留已完成材料与已收到的用量。管理中心的模型错误使用 502/504 返回，不会因服务商返回 401 而清除 TAgent 登录。正确显示降级报告不代表模型已经连通，中断请求仍可能被服务商计费。

管理中心“模型连接”可查看配置并独立预览短请求。勾选费用确认后才调用一次模型，不发送会话或工作文件；刷新不重跑，保存失败只重试保存，未收到用量时不记为零费用。一次成功不代表调研或工具可用，详见 [连接诊断与边界](./docs/model-connection.md)。

办公交付核对在用户任务内最多增加3次模型调用（核对、一次修订、重新核对），计入当前任务预算与用量，不是后台 Benchmark。模型价格未知、预算不足、内容过大或核对请求失败时，保留草稿并显示未完成核对；没有自动网络重试。核对不能替代工具审批，也不会撤销已经执行的外部操作。

任务运行时可点击输入框右侧的停止按钮。取消、浏览器断连或达到总运行时限后，会中断支持取消的模型/工具，清理本任务资源并保存已有材料；不会把停止当成完成交付。`TAGENT_RUN_TIMEOUT_MS` 默认 600000（10 分钟），清理与保存另计。已执行的外部操作不会撤销，中断请求也可能被服务商计费。保存失败会直接提示，不能当作已保存。

同一页面内切换会话或进入管理中心不会取消原任务；消息、草稿、停止按钮和工作流按会话隔离。执行记录默认折叠，展开后可滚动查看。刷新或关闭浏览器会断开原连接，由后端停止并保存已有材料；重新进入会话可核对保存结果，不会自动续跑或重试模型。草稿和未保存回复仅保留在当前登录页面内，退出登录会清除；保存失败时不要直接刷新。

同一会话已有任务时，新的提交会被拒绝，不会重复调用模型。单个后端默认最多同时处理4个任务（`TAGENT_MAX_ACTIVE_RUNS`，可设1–16），停止和保存阶段仍占用名额；没有自动排队或重试。单条消息默认上限64 KiB，按 UTF-8 字节计算（`TAGENT_MAX_TASK_INPUT_BYTES`，可设1024–524288）。明确未接收的任务会恢复为草稿，用户可修改后再发，不生成虚假的失败回复。HTTP 正文另有2 MiB和30秒接收限制。以上是单实例任务保护，不等于请求速率、模型费用硬限额或多实例互斥。

HTTP另有滚动分钟限流：默认读取600次、写入120次、联网/模型入口30次；停止、审批和退出使用独立额度，429明确等待时间，不自动重试。新会话准备被拒绝也保留草稿。WebSocket限制握手、连接数量、消息频率及16 KiB完整/分片消息，不影响已开始SSE的事件输出。配置和具体边界见 [单实例访问保护](./docs/self-hosted-access.md)，不是公网DDoS或费用硬上限保证。

**模型连通不等于搜索可用。** 调研搜索默认保留原有来源；在管理中心“调研搜索”中查看外发范围，明确确认后可测试来源或保存启用 Parallel。测试不会切换来源，保存只影响新任务。部署环境的 `TAGENT_SEARCH_PROVIDER` 优先于页面设置；不安装 MCP、不执行外部命令。配置、隐私边界与真实检索验收见 [调研搜索](./docs/research-search.md)。Skill/MCP 联网发现是另一条链路，不受此选项控制。

首次安装保持 `TAGENT_SEARCH_PROVIDER` 注释即可使用页面选择。管理员在 `.env` 或进程环境中显式设置 `auto` / `parallel` 会锁定来源；已有实例如需改回页面管理，须由管理员移除该设置并重启，系统不会自动改写配置文件。

如果配置 `DATABASE_URL`，服务端会使用 PostgreSQL；否则使用文件持久化。`REDIS_URL` 也是可选项，连接失败不会阻止服务启动。

Workspace、Session、消息和消息中的 Trace 会在写入成功后再返回，重启时从同一存储恢复。默认路径为项目根目录 `.tagent/data/workspaces.json`；`TAGENT_WORKSPACE_ROOT` 可指定独立数据根目录。已配置数据库不可用或存储文件损坏时，启动会报错，不会用空数据覆盖。

连续对话会把同一会话的有界历史参考传给规划、执行和核对阶段，运行记录显示纳入与省略情况；不会自动读取其他会话或重放旧工具授权。分支支持全文 Diff、选择原文、预览后确认引用到主线，引用不调用模型。摘要 Fork 可选择完整保留的消息，预览外发范围与费用后单独确认；同一操作只调用一次模型，已知费用记录在来源会话，保存失败只重试本地保存，重启不自动重跑。提取的原文可回查，但不保证信息齐全或事实正确。具体范围、成本与未完成项见 [连续对话与分支引用](./docs/session-context.md)。

常驻 Agent 的新建、编辑、Skill/MCP 绑定和确认沉淀也在写入成功后才发布，文件模式保存到 `.tagent/data/resident-agents.json`。旧 `.tagent/agents.json` 绑定继续读取，新保存的完整配置优先；不会改写旧文件。大厅保存失败或版本冲突时保留当前草稿，网络响应不明时应刷新列表核对，避免重复操作。子 Agent 预览不保存，确认后复制为独立常驻 Agent；忙闲状态不随常驻配置持久化。旧版本已随进程退出丢失的内存配置不能凭空恢复。

Agent 编辑器将 MCP 的“绑定”和“允许调用”分开；stdio 服务还须在 MCP 管理中独立授权执行。Skill 的“允许读取附属文件”只开放已绑定包内文本，不执行脚本或读取任意磁盘路径。勾选后点击“保存 Agent”才生效，拖拽绑定不自动授予权限；原有自定义白名单保留。MCP 工具标识由后端返回，与运行时一致，重名冲突会提示而不会自动改名或扩大权限。

评分检查独立保存到 `.tagent/data/benchmarks.json`，当前保留全局最近200条、每个 Agent 展示最近20条。记录包含规则版本、配置指纹和可回查的任务/事件标识；配置变化后旧记录仍可看，但不再用于当前评分。查看、配置检查、任务记录复核都不调用模型、工具或联网。只接受服务器保存的同一任务 Trace，客户端自报分数和 Smoke 样例不能作为证据；历史检查并非完整、永久评测档案，也不证明来源真实或办公任务合格。

主 Agent 的任务计划可请求受控子 Agent 分工：继承父配置和权限，预算进一步收紧，最大两层且不能超过父 Agent 原有设置。任务历史写入 `.tagent/data/task-agents.json`，包含来源、输入摘要、状态、完整输出和已知用量；提交成功后才对外发布。重启把未结束的执行标为中断，不自动重跑。大厅的“任务子 Agent”分区可展开记录，确认后复制到常驻区，原任务与 Trace 保留。手动创建接口只保存未执行记录，不代表已运行任务。当前是初始计划驱动的受控分工，尚不是 Agent Loop 内随时自主递归；真实模型选人质量、跨进程硬预算和大规模历史索引仍待验收。

新任务会原子保存提问和运行标记，并在执行中保存独立检查点。服务异常退出后，再次启动会把未收尾任务整理为中断报告，恢复已保存的来源、子任务材料、Trace 和已知用量；不会自动重新调用模型或工具。已保存但尚未写回会话的最终报告，只补做本地保存，不重复执行或计费。尚未落盘的数据无法保证恢复，外部操作状态不明时应先核实再重试。当前同一数据目录/数据库仅支持一个后端实例，不要启动多个实例共同写入。

服务默认仅监听 `127.0.0.1`。已具备单实例所有者访问保护，但公网 TLS、多用户隔离与完整发布验收尚未完成；完整门槛见 [上线验收与开发清单](./docs/release-readiness.md)。`/api/health` 中模型 `configured` 仅代表配置存在，`connectivity: unchecked` 不代表模型调用已经验证成功。

已增加单实例访问保护：对外监听或生产模式必须配置独立访问码和 HTTPS 站点来源，浏览器使用 HttpOnly 登录会话；本机开发模式不强制新增访问码。配置、代理与验收步骤见 [自托管访问保护](./docs/self-hosted-access.md)。这不等同于多用户权限或完整公网发布验收。

Skill/MCP 联网发现和调研搜索是两条独立链路。管理中心的 GitHub 请求已共享有界内存缓存，遇到限流会显示重试时间；`GITHUB_TOKEN` 或 `GH_TOKEN` 可启用代码搜索。搜索、填入来源、导入预览和确认保存仍分开，候选不代表包已验证可运行。直接粘贴来源地址不会把该地址作为关键词发送给搜索网站。

### 3. 可选：启动数据库

```bash
docker compose up -d
```

> PostgreSQL 16 -> `localhost:5432`，Redis 7 -> `localhost:6379`

### 4. 构建与运行

以下命令都从项目根目录执行。先完成构建，再在两个独立终端分别启动后端与前端；这是仅监听本机的开发运行方式，HTTPS部署见 [自托管访问保护](./docs/self-hosted-access.md)。

```bash
# 构建 Web/Server 及共享依赖
pnpm --filter @tagent/server... build
pnpm --filter @tagent/web build

# 启动后端（端口 3001）
pnpm --filter @tagent/server dev

# 启动前端（端口 3000）
pnpm --filter @tagent/web dev
```

### 5. 验证

```bash
# 健康检查
curl http://localhost:3001/api/health

# 完整本地门槛：顺序构建、四包类型/lint、回归、生产构建、隔离 HTTP/恢复验收
pnpm check

# 单元测试
pnpm exec vitest run

# 后端构建后运行隔离 HTTP 验收，不使用 API Key 或现有用户数据
node scripts/verify-server-lifecycle.mjs
```

首次安装或依赖变化后，建议使用 `pnpm install --frozen-lockfile --ignore-scripts`，再运行 `pnpm check`。完整校验不会启动用户服务、导入包或安排真实搜索/付费模型；跨包测试前会重新构建共享依赖，失败立即停止。测试环境使用临时数据目录，不读取后端 `.env`。浏览器、真实交付物和部署验收仍独立执行，详见 [构建与发布校验](./docs/release-checks.md)。

## 关键入口

| 入口 | 说明 |
|------|------|
| `http://localhost:3000` | Web 主界面：Workspace、Session、聊天、工作流看板、推理时间线 |
| `http://localhost:3000/management/skills` | Skills 技能库 |
| `http://localhost:3000/management/agents` | Agent 大厅与能力绑定 |
| `http://localhost:3000/management/mcp` | MCP 工具管理 |
| `http://localhost:3000/management/search` | 调研搜索来源、外发确认与连接测试 |
| `http://localhost:3000/management/model` | 模型配置、短请求费用确认与连接诊断 |
| `http://localhost:3000/management/governance` | 治理仪表盘 |
| `GET /api/health` | 后端健康检查 |
| `POST /api/agent/orchestrate` | 多 Agent 编排执行入口 |
| Workspace / Session API | 工作空间、对话、Fork、Diff、结论引用 |
| `GET /api/workspaces/:wsId/sessions/:sessId/traces/:runId` | 当前任务的统一事件、筛选与分页回查 |
| Skills / MCP / Agents / Governance API | 管理中心数据接口 |

## 数据存储

| 服务 | 本地路径或配置 | 说明 |
|------|---------------|------|
| File persistence | `.tagent/` 等本地目录 | 未配置数据库时的默认持久化 |
| PostgreSQL | `DATABASE_URL` / `data/postgres/` | 可选KV存储；真实数据库集成与Trace数据库索引待验收 |
| Redis | `REDIS_URL` / `data/redis/` | 可选缓存层 |
| 任务Trace索引 | `.tagent/workflow-index/` | 统一事件JSONL与字节偏移索引，原始消息/检查点为权威数据 |
| 旧Trace日志 | `traces/`、`.tagent/traces/` | 旧版TraceWriter/CLI日志，不是Web会话回查的数据源 |

> `data/` 已加入 `.gitignore`，不会被提交。

## 测试

```bash
pnpm exec vitest run                  # 单元和回归测试
node --import tsx scripts/verify-workflow-history.mts # 后端构建后：分页/重启/两路SSE一致性，无付费调用
node scripts/verify-server-lifecycle.mjs  # 后端构建后：重启/Fork/消息/失败输出验收
node scripts/verify-agent-persistence.mjs # Agent 创建/编辑/绑定/沉淀、重启、冲突和写入失败
node scripts/verify-benchmarks.mjs     # 配置评分/任务证据、持久化、过期记录和磁盘故障；仅本地模拟模型
pnpm exec tsx scripts/verify-office-benchmark.mts # 受控八题内核，两种真实SDK仅连接本机夹具，不计为Agent实测成绩
pnpm exec tsx scripts/verify-office-benchmark-api.mts # 隔离后端：确认、进度、取消、重启与写入故障，不调用付费API
node scripts/verify-provider-failures.mjs # 本地模拟模型：连接/超时/错误脱敏、唯一终态与重启恢复
node scripts/verify-model-connection.mjs # 两种SDK、本机模型：确认、防重、错误、保存故障与重启
```

## 开发协作建议

1. 先确认 `GET /api/health` 正常，再进入端到端联调。
2. 文档或 UI 变更后，优先跑对应包的 typecheck/build。
3. Agent Runtime、治理、协议相关改动至少跑 `pnpm test -- --run`。
4. 做新功能前先对照 [创新审查清单](./innovation_review_checklist.md)，确认是否需要降级或分期。

## 文档

- [产品分析与实施方案](./implementation_plan.md)
- [上线验收与开发清单](./docs/release-readiness.md)
- [构建校验与源码候选交付](./docs/release-checks.md)
- [Agent 评测边界与实跑内核](./docs/agent-benchmark.md)
- [办公交付核对与中断回查](./docs/office-delivery.md)
- [模型连接诊断](./docs/model-connection.md)
- [自托管访问保护](./docs/self-hosted-access.md)
- [联网工具访问边界](./docs/public-network-boundary.md)
- [创新审查清单](./innovation_review_checklist.md)
- [前端设计参考](./docs/frontend-references/)

## 独立开源工具

三个从本项目提取的小工具已分别建立公开仓库，均可独立运行，不依赖 TAgent 服务或模型 API：

- [Agent Trace Kit](https://github.com/liulinlin718-netizen/agent-trace-kit)：执行记录校验、阶段整理与 CLI。
- [Approval-First Import](https://github.com/liulinlin718-netizen/approval-first-import)：候选预览、风险信息与显式确认契约。
- [Evidence-Bound Review](https://github.com/liulinlin718-netizen/evidence-bound-review)：有限规则范围内、可回查原文的办公材料检查。

本仓库保留 [对应源码与使用边界](./opensource/README.md)。GitHub 源码发布不等于 npm 发布或生产质量认证；环境文件、本地会话、运行日志和验收产物不随本次更新上传。

## License

[MIT](./LICENSE)
