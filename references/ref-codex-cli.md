# 参考笔记：Codex CLI

> 来源：[OpenAI Codex CLI](https://github.com/openai/codex) · OpenAI 官方终端 Agent
> 定位：沙箱安全 + 审批分级 + App Server 架构

---

## 架构：Agent Loop + App Server

### Agent Loop
与其他项目类似的迭代循环：接收输入 → LLM 推理（Responses API）→ 执行工具 → 观察结果 → 循环

### App Server 架构（2026）

- 将核心 Agent 逻辑从客户端表面（CLI/VS Code/Web/Desktop）解耦
- 双向 JSON-RPC 接口，一套后端服务所有前端
- **与我们的目标一致**：Agent Runtime 独立于 UI

**启发**：我们的 Agent Loop 也应暴露标准化 API（WebSocket/JSON-RPC），让前端可以是 Web、CLI、甚至移动端。

---

## 三级审批模式

| 模式 | 文件编辑 | Shell 命令 | 适用场景 |
|------|---------|-----------|---------|
| **Suggest** (默认) | 需审批 | 需审批 | 日常使用 |
| **Auto-Edit** | 自动 | 需审批 | 信任编辑但谨慎执行 |
| **Full-Auto** | 自动 | 自动 | CI/CD、隔离环境 |

Full-Auto 模式强制启用沙箱 + 禁用网络。

**启发**：这和我们治理引擎的 硬约束/软约束 概念完全对应：
- Suggest = 全部硬约束
- Auto-Edit = 编辑软约束 + 执行硬约束
- Full-Auto = 全部软约束（但沙箱兜底）

我们可以让用户在项目 Plan 阶段用自然语言选择类似的"信任级别"。

---

## 沙箱安全

| 平台 | 沙箱技术 |
|------|---------|
| macOS | Apple Seatbelt (`sandbox-exec`) |
| Linux | Bubblewrap / Docker |

- 工具执行限制在工作区目录内
- 网络访问默认关闭
- 配合 Git 版本控制可随时回滚

**启发**：我们的 Agent 执行环境也需要沙箱——特别是当 Agent 操作文件系统或浏览器时。可考虑 Docker 容器化。

---

## MCP 集成

- 2025 年全面采用 MCP 标准
- 动态发现和调用外部工具
- OAuth 2.1 认证 + 审计
- 早期存在安全漏洞（CVE-2025-61260）：项目本地 MCP 配置文件可被注入恶意命令

**启发**：MCP 配置的安全加载是必须考虑的——不能无条件信任项目级配置文件。

---

## Apply Patch 工具

- 用 `apply_patch` 工具实现代码变更
- 根据审批模式决定是否需要人工确认

---

## 对 TAgent 的启发总结

1. **App Server 解耦**验证了 "Agent Runtime 独立于 UI" 的正确性
2. **三级审批**可映射到治理引擎的约束严重度
3. **沙箱 + Git 回滚**是安全执行的两道防线
4. **MCP 配置安全**是实际部署中的重要考量
