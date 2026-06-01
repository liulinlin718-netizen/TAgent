# 参考笔记：Pi Framework

> 来源：[earendil-works/pi](https://github.com/earendil-works/pi) · TypeScript 模块化 Agent 框架
> 定位：分层 Monorepo + LLM 抽象层 + 可嵌入 SDK

---

## 架构：四层 Monorepo

```
pi-ai          →  LLM 抽象层（统一 API，多 Provider）
pi-agent-core  →  Agent 运行时（循环、状态、工具执行）
pi-coding-agent → 编码 Agent CLI（内置工具、会话持久化）
pi-tui / pi-web-ui → 终端 / Web UI
```

### 分层解耦

| 层 | 职责 | 特点 |
|----|------|------|
| `pi-ai` | LLM 归一化 | 统一 streaming / tool calling / cost tracking，屏蔽 Provider 差异 |
| `pi-agent-core` | Agent Loop | 工具编排、事件流、状态管理——**不绑定任何 UI** |
| `pi-coding-agent` | 具体场景 | 文件读写、bash 执行、JSONL 会话持久化 |
| `pi-tui` | 展示层 | 差异渲染、Markdown 显示 |

**启发**：这种分层和我们的架构高度契合。关键学习点是 **Agent Runtime 和 UI 完全解耦**——`pi-agent-core` 可以被 CLI、Web、甚至其他项目（如 OpenClaw）嵌入使用。我们的 Agent Loop 也应设计为可独立运行的模块。

---

## LLM 抽象层

- 统一 API 对接 OpenAI / Anthropic / Google / 本地模型
- 内建 token 计算 + 成本追踪
- 支持运行时切换模型（不改业务代码）

**启发**：我们的 AI 层应参考此设计——Model-Agnostic + 内建成本追踪。成本数据可以直接喂给治理引擎的资源协议。

---

## 会话持久化：树形历史

- 不同于线性 JSONL，Pi 使用**树形结构**的会话历史
- 支持分支探索和回溯

**启发**：这与我们的 Session Fork 概念天然吻合。可参考其数据结构设计。

---

## 对 TAgent 的启发总结

1. **Agent Runtime 与 UI 解耦**是关键架构原则
2. **LLM 抽象层 + 内建成本追踪**可以直接复用设计
3. **树形会话历史**验证了我们的 Session 分支设计方向
4. Monorepo 分层组织方式适合我们的项目结构
