# 参考笔记：Hermes-Agent-Team

> 来源：[linke-ai/hermes-agent-team](https://github.com/linke-ai/hermes-agent-team) · 本地多 Agent 团队协作 Web 系统
> 定位：提取落地经验，不照搬架构

---

## 实时通信方案

- **SSE** 负责结构化事件（任务创建、状态变更、完成通知）
- **WebSocket** 负责高频流式输出（Agent 运行时终端）
- 两条通道分离，高频输出不做持久化 → 性能正确

**启发**：我们采用同样的双通道方案。

---

## Agent 多维状态

单一 `status` 字段不够用，需要多维度：

| 维度 | 示例值 | 驱动什么 |
|------|--------|---------|
| 业务状态 | idle / busy / waiting | UI 节点动画 |
| 运行时 | stopped / running / error | 健康监控 |
| 人机交互 | idle / waiting_human | 用户提示 |
| 编排 | none / waiting_workers | 流转视图 |

**启发**：Agent Card 应采用多维状态模型，直接驱动 UI 渲染。

---

## MCP 集成

- 支持三种传输：`http` / `streamable_http` / `stdio`
- Agent 通过 MCP 工具发现和调度其他 Agent（解耦）
- `request_human_input()` 是"用户升级"的实用实现

**启发**：三种传输方式全支持；`request_human_input` 参考治理引擎的用户升级。

---

## Skill 管理

- Markdown + frontmatter 定义元信息 → 与我们的 Skills 设计一致
- 支持安装 / 卸载 / 重装
- 每个 Agent 独立的 SOUL.md（人设定义）

---

## 团队导入/导出

- 打包 profile + skills + 可选 workspace
- 敏感信息（API Key、MCP headers）自动脱敏

---

## 对 TAgent 的启发总结

1. **SSE + WebSocket 双通道**是经过验证的实时方案
2. **多维状态模型**比单一 status 精确得多
3. **MCP 三种传输**在管理界面中需全部支持
4. **团队导出 + 脱敏**是后期需实现的功能
