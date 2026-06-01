# 参考笔记：OpenClaw

> 来源：[OpenClaw GitHub](https://github.com/anthropics/openclaw) · 开源个人 AI Agent
> 定位：三层架构 + 持久化驻留 + 主动调度

---

## 架构：Channel → Brain → Body

| 层 | 职责 | TAgent 对应 |
|----|------|------------|
| **Channel (Gateway)** | 多平台接入（WhatsApp/Telegram/Slack），消息归一化，会话路由 | 我们的 Web 前端层 |
| **Brain (Agent Runtime)** | LLM 推理、ReAct 循环、上下文组装、工具决策 | 我们的 Agent Loop |
| **Body (Execution)** | 浏览器(Playwright)、文件系统、Shell、MCP 工具 | 我们的能力层 |

**启发**：三层分离使每层可独立替换。我们可以参考同样的分层：接入层 / 编排层 / 执行层。

---

## 持久化驻留 + 主动调度

OpenClaw 作为后台 daemon 常驻运行，有两个主动调度机制：

| 机制 | 触发方式 | 用途 |
|------|---------|------|
| **Heartbeat** | 每 30 分钟自动触发 | 读取 `HEARTBEAT.md` 检查清单，有事才通知 |
| **Cron** | 标准 cron 表达式 | 定时任务，持久化到 SQLite |

**启发**：TAgent 的常驻 Agent 可以借鉴 Heartbeat 模式——不是空转等待，而是周期性巡检 + 按需通知。比 polling 优雅。

---

## Skills 系统

- Skills 以 **Markdown 文件**定义，Agent 运行时读取
- 无需重新编译即可扩展能力
- 与我们的 Skills 设计完全一致

---

## 对 TAgent 的启发总结

1. **三层分离**架构是经过验证的模式，值得采用
2. **Heartbeat 巡检**模式适合常驻 Agent 的主动行为设计
3. **Cron 定时任务**是 Phase 4 可以加入的功能
4. OpenClaw 是**单 Agent** 架构，我们的多 Agent 递归裂变是差异化
