# 🧠 TAgent — AI 办公协作助手

> 让非技术用户也能轻松驾驭多 Agent 协作的可视化平台

## ✨ 特性

- **多 Agent 编排** — 主 Agent 自动分解复杂任务，调度常驻/任务 Agent 并行协作
- **递归裂变** — 所有 Agent 可按需创建子 Agent，结果逐级上交
- **实时可视化** — React Flow 工作流看板 + 推理时间线 + SSE/WebSocket 双通道
- **治理引擎** — 5 类治理协议（资源/质量/安全/方向/组织），三级审批
- **Skills 系统** — Agent 任务成功后可提炼为 Skill，拖拽分配给其他 Agent
- **MCP 集成** — 支持 stdio/SSE/streamable-http 三种传输
- **Session 分支** — 3 种创建方式（新建 / 完整 Fork / 摘要 Fork）+ Diff 对比
- **宇宙深空 UI** — Aurora 光晕 + Glassmorphism + PulseOrb 动效

## 📦 架构

```
packages/
  tagent-ai/        → LLM 抽象层（Anthropic / OpenAI / DeepSeek + 成本追踪）
  tagent-core/      → Agent Runtime（Loop / 编排器 / 治理 / 通信协议）
  tagent-server/    → App Server（Hono + SSE + WebSocket API）
  tagent-web/       → Next.js 15 前端（React Flow / Framer Motion / Radix UI）
  tagent-desktop/   → Electron 桌面端（规划中）
```

## 🚀 快速开始

### 前置条件

- **Node.js** ≥ 18
- **pnpm** ≥ 9
- **Docker Desktop**（用于数据库）

### 1. 安装依赖

```bash
pnpm install
```

### 2. 启动数据库

```bash
docker compose up -d
```

> PostgreSQL 16 → `localhost:5432` | Redis 7 → `localhost:6379`

### 3. 配置环境变量

```bash
cp packages/tagent-server/.env.example packages/tagent-server/.env
# 编辑 .env，填入你的 API Key
```

### 4. 构建 & 运行

```bash
# 全量构建
pnpm -r build

# 启动后端（端口 3001）
cd packages/tagent-server && pnpm dev

# 启动前端（端口 3000）
cd packages/tagent-web && pnpm dev
```

### 5. 验证

```bash
# 健康检查
curl http://localhost:3001/api/health

# 运行测试
pnpm test -- --run
```

## 🗂️ 数据存储

| 服务 | 本地路径 | 说明 |
|------|---------|------|
| PostgreSQL | `data/postgres/` | KV 存储 + Trace 索引 |
| Redis | `data/redis/` | 缓存层（AOF 持久化） |
| Trace 日志 | `.tagent/traces/` | JSONL append-only |

> `data/` 已加入 `.gitignore`，不会被提交。

## 🧪 测试

```bash
pnpm test -- --run     # 29 tests (governance + protocol)
pnpm -r build          # 5/5 packages
```

## 📖 文档

- [产品分析与实施方案](./implementation_plan.md)
- [创新审查清单](./innovation_review_checklist.md)
- [前端设计参考](./docs/frontend-references/)

## 📄 License

MIT
