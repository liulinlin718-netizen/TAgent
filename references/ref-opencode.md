# 参考笔记：OpenCode

> 来源：[opencode-ai/opencode](https://github.com/opencode-ai/opencode) · Go 语言 AI 编码 Agent
> 定位：Plan/Build 分离 + 事件驱动 JSONL + LSP 集成

---

## 架构：Plan Agent + Build Agent

| Agent | 权限 | 职责 |
|-------|------|------|
| **Plan** | 只读 | 分析代码、审查建议、制定策略 |
| **Build** | 完全工具权限 | 实现变更、运行测试、执行命令 |

**启发**：计划与执行的角色分离是一个经过验证的模式。我们的主 Agent 在裂变之前应先经过"规划步骤"（对应我们 Agent Loop 的步骤①），这不是一个独立 Agent，而是循环内的必经阶段。

---

## 事件驱动 JSONL 消息系统

### Inbox 模式

- 每个 Agent 有独立的 JSONL 文件作为"收件箱"
- **Append-only O(1)**写入（不重写整个文件）
- 消息注入到接收者的 session 中，LLM 自然处理

**启发**：
1. JSONL append-only 是高效的事件日志方案
2. 我们的 Trace 数据（Observability）可以用类似的 append-only 模式存储
3. Agent 间通信作为"收件箱消息"注入的思路很实用

---

## 工具注册 + 安全

- 统一工具注册表：`read`, `write`, `edit`(AST), `bash`, `grep`, `task`(子Agent)
- `task` 工具用于创建子 Agent —— 和其他工具同级
- 权限门控：不同权限级别对应不同工具集
- **Snapshot 系统**：执行前快照，可撤销操作

**启发**：
1. 子 Agent 创建作为一种"工具"而非特殊机制——这简化了架构
2. Snapshot 撤销能力对安全很重要，可加入我们的治理引擎

---

## LSP 集成

- 连接语言服务器获取实时诊断、类型信息、符号导航
- Agent 拥有和 IDE 同等的代码理解能力

**启发**：如果 TAgent 未来面向开发场景，LSP 集成可以显著提升代码相关任务的质量。Phase 2+ 考虑。

---

## Provider 抽象

- LLM Provider 可随时切换，不改编排逻辑
- 与 Pi 的设计思路一致

---

## 对 TAgent 的启发总结

1. **Plan/Build 分离**验证了"先规划再执行"的价值
2. **JSONL append-only** 适合 Trace 和事件日志
3. **裂变 = 调用 `task` 工具**的设计简洁优雅
4. **Snapshot 撤销**是治理引擎的安全保障
