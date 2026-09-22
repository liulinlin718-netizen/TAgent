# TAgent

> 面向非技术用户的可视化多 Agent 办公协作平台。

TAgent 将调研、文档、数据分析、项目管理、沟通邮件和演示汇报等办公任务交给专业 Agent 协作完成。用户可以像发起一段对话一样描述目标，同时在可视化工作流中了解任务如何被拆解、由谁执行、调用了哪些工具、触发了哪些治理规则，以及最终结果基于哪些材料形成。

TAgent 的重点不是把更多 Prompt 塞进聊天窗口，而是让多 Agent 工作变得可理解、可配置、可追溯：

- 普通用户可以直接使用常驻办公 Agent，也可以从一次任务沉淀新的 Agent。
- Agent 通过结构化运行阶段、Skills、工具权限和质量规则执行任务。
- 任务过程以统一事件记录驱动实时流转、静态架构和事件日志。
- Skill 与 MCP 的发现、预览、风险检查、保存和执行授权彼此分离。
- 失败、中断和预算不足都会保留已有材料并返回可读说明，不伪装成成功。

## 核心能力

### 专业办公 Agent

系统内置六类常驻 Agent：

| Agent | 主要职责 |
| --- | --- |
| 研究 Agent | 联网检索、来源读取、日期核对、证据整理和调研报告 |
| 文档 Agent | 结构化写作、材料整合、内容修订和 Word 交付 |
| 数据 Agent | 表格读取、统计计算、口径说明、异常检查和 Excel 结果 |
| 项目管理 Agent | 任务拆解、依赖、排期、风险、责任缺口和验收建议 |
| 沟通邮件 Agent | 邮件草稿、会议纪要、行动项和沟通语气调整 |
| 演示汇报 Agent | 页面级提纲、核心结论、证据组织和演示叙事 |

每个 Agent 使用结构化 Agent Card，包含角色设定、职责边界、默认 Skills、工具白名单、MCP 偏好、成本约束、质量规则、失败降级策略和示例任务。运行时采用 `Understand → Plan → Execute → Verify → Synthesize → Handoff` 阶段，而不是单轮 Prompt 调用。

复杂任务可以创建受控子 Agent。子 Agent 继承并收紧父 Agent 的权限与预算，保留父子关系和完整 Trace；只有用户明确确认后，才会复制为新的常驻 Agent。

### 可视化工作流

右侧 Workflow Drawer 与主对话并列，可收起并拖拽调整宽度，提供三个互相一致的视图：

- **实时流转**：按拆解、调度、调研、工具、治理、综合等阶段分组展示任务进展。
- **静态架构**：只展示当前任务实际参与的 Agent、工具、MCP 与治理节点，关系边默认可见。
- **事件日志**：按运行、Agent 和事件类型筛选统一 `WorkflowEvent`，支持长记录分页回查。

任务事件同时用于实时界面、历史回放、治理记录和 Agent 评分，避免不同页面各自推导一套互相矛盾的流程。

### Skill Package

Skill 是可复用的能力包，不只是一段 Prompt。一个 Skill 可以包含：

- 基础信息、触发条件和适用 Agent
- SOP / Prompt 与执行步骤
- 输入、输出和质量约束
- 工具、MCP 和外部 API 依赖
- 参考资料、模板和检查清单
- 示例任务与最小测试样例
- 风险等级和版本信息

管理界面为普通用户提供简化编辑器，高级字段按需展开。Skill 可从本地创建，也可通过 GitHub、URL 等来源进入导入预览；远程内容不会因为搜索或预览而自动保存或执行。

### MCP 管理

MCP 管理支持手工配置、URL/GitHub/npm/Registry 候选发现、导入预览、远程连接测试和工具列表展示。环境变量与认证信息在界面中脱敏。

搜索、导入和执行是三个独立动作：

```text
发现候选 → 查看来源 → 导入预览 → 风险确认 → 保存配置 → 单独授权执行
```

stdio 配置只展示结构化命令和所需环境变量；预览与连接检查不会静默运行外部命令。

### 调研与证据

当任务涉及最新资讯、近 30 天、趋势、新闻或现状时，研究 Agent 会进入联网调研流程。搜索候选与实际读取状态分开记录，最终报告可以展示调研日期、来源日期、URL 和可验证性。

证据核对用于发现来源缺失、日期越界、引用不匹配和材料范围扩大等问题。它是辅助审阅机制，不是独立事实认证；没有发现问题不代表外部事实必然正确。

### 治理与安全

TAgent 将工具能力和执行授权分开管理：

- Agent 只能调用其白名单中的工具与 MCP。
- 高风险操作需要显式确认，超时或保存失败不会授予许可。
- URL、重定向和私有地址访问经过限制。
- 外部 Skill/MCP 必须先预览来源、文件、命令、环境变量和风险。
- 取消或服务中断时保留已完成材料、已知费用和任务状态，不自动重放工具。
- 文件模式支持离线备份；恢复到新目录时撤销旧 MCP 执行授权。

### 会话与分支

Workspace 中的 Session 支持：

- 连续对话与有界上下文
- 完整 Fork 与摘要 Fork
- 分支树和全文 Diff
- 从分支摘取原文并引用回主线
- 任务检查点与异常中断回查

TAgent 不自动合并整段对话。用户通过“结论摘取引用 + Diff”决定哪些内容回到主线。

### Agent 评测

Agent 大厅使用七个维度展示能力：调研与事实验证、指令遵循、工具使用、规划拆解、办公交付、治理安全和协作交接。

评分会明确标注来源：静态配置估算、已保存任务观察或用户手动触发的固定材料 Benchmark。打开大厅不会自动产生模型费用，评测结果也不会被描述为外部权威榜单成绩。

## 系统架构

```text
packages/
  tagent-ai/       LLM Provider 抽象、流式事件、工具调用与费用计算
  tagent-core/     Agent Runtime、Orchestrator、Skills、MCP、治理与 Trace
  tagent-server/   Hono API、SSE、WebSocket、持久化与管理接口
  tagent-web/      Next.js Web 应用、对话、工作流与管理中心
  tagent-desktop/  Electron 桌面端代码目录
```

核心数据流：

```text
用户任务
  → Orchestrator 理解与拆解
  → 选择常驻 Agent / 创建任务子 Agent
  → Skills + 工具/MCP 权限执行
  → 统一 WorkflowEvent 与治理记录
  → 质量核对、综合和交接
  → 结构化回复、来源与可下载交付物
```

## 快速开始

### 环境要求

- Node.js `>= 22.13`
- pnpm `10.12.1`
- 至少一个受支持的模型 API Key
- PostgreSQL 和 Redis 可选；未配置时使用本地文件持久化

### 安装

```bash
git clone https://github.com/liulinlin718-netizen/TAgent.git
cd TAgent
pnpm install --frozen-lockfile --ignore-scripts
```

复制后端配置：

```bash
cp packages/tagent-server/.env.example packages/tagent-server/.env
```

配置以下任一模型：

```dotenv
DEEPSEEK_API_KEY=...
# ANTHROPIC_API_KEY=...
# OPENAI_API_KEY=...
```

可通过 `TAGENT_LLM_PROVIDER` 和 `TAGENT_LLM_MODEL` 显式选择 Provider 与模型。调研搜索、访问保护、数据库、Redis 和可选办公核对模型的配置项见 [.env.example](./packages/tagent-server/.env.example)。

### 本地运行

Windows 本机生产构建与受控启动：

```powershell
pnpm local:build
pnpm local:start
```

访问：

- Web：<http://127.0.0.1:3000/>
- Health：<http://127.0.0.1:3001/api/health>

停止服务：

```powershell
pnpm local:stop
```

通用开发模式：

```bash
pnpm dev
```

### 工程检查

```bash
pnpm check
```

该命令执行共享包构建、类型检查、lint、单元测试、Web 生产构建和隔离接口检查。真实模型、搜索和第三方 MCP 连接需要单独授权，不属于默认检查。

## 重要接口

- `GET /api/health`
- `POST /api/agent/orchestrate`
- Workspace / Session / Fork / Diff / Quote APIs
- Skills / MCP / Agents / Governance 管理 APIs
- Benchmark 与 Runtime APIs

前端工作流只消费共享的 `WorkflowEvent`；Agent 大厅、Orchestrator 和 Benchmark 共享 `AgentCardV2`；Skill 编辑、导入和绑定共享 `SkillPackage`。

## 部署与数据

默认服务仅监听 `127.0.0.1`。如需通过网络访问，请配置 HTTPS、可信站点来源和独立访问码，参阅 [自托管访问保护](./docs/self-hosted-access.md)。安全模型面向单实例所有者部署，不应直接视为多租户 SaaS 权限系统。

未配置 `DATABASE_URL` 时，数据保存在项目数据目录；配置后可使用 PostgreSQL。`REDIS_URL` 为可选缓存。不要让多个后端实例同时写入同一个文件数据目录。

## 文档导航

- [实现与产品设计](./implementation_plan.md)
- [本机 Windows 运行](./docs/local-windows.md)
- [访问保护](./docs/self-hosted-access.md)
- [调研搜索](./docs/research-search.md)
- [办公交付核对](./docs/office-delivery.md)
- [工作流与长任务](./docs/workflow-performance.md)
- [Agent 评测](./docs/agent-benchmark.md)
- [工具确认与导入治理](./docs/governance-approval.md)
- [连续对话与分支](./docs/session-context.md)
- [数据分析与 Excel](./docs/data-analysis.md)
- [Word 导出](./docs/report-export.md)
- [备份与恢复](./docs/data-backup.md)

## 独立工具

TAgent 的三个通用机制也以小型、可独立使用的开源工具提供：

- [Agent Trace Kit](https://github.com/liulinlin718-netizen/agent-trace-kit)：校验、整理和查询 Agent WorkflowEvent JSONL。
- [Approval-First Import](https://github.com/liulinlin718-netizen/approval-first-import)：为 Skill/MCP 导入提供内容绑定的预览与确认门。
- [Evidence-Bound Review](https://github.com/liulinlin718-netizen/evidence-bound-review)：在给定材料范围内检查办公报告的明确约束冲突。

## 许可

[MIT License](./LICENSE)。第三方依赖和导入内容遵循其各自许可证。
