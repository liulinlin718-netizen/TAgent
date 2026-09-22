# TAgent 独立工具

这里包含从 TAgent 通用机制中提取的三个小型开源工具。它们各自解决一个明确问题，可以独立复制和使用，不依赖 TAgent 服务，也不会改变主项目运行依赖。

| 项目 | 用途 | 最小使用方式 |
| --- | --- | --- |
| [Agent Trace Kit](https://github.com/liulinlin718-netizen/agent-trace-kit) | 校验和整理 Agent WorkflowEvent JSONL，构建运行、阶段、父子关系与工具调用视图 | `node bin/agent-trace.js summary examples/research.jsonl` |
| [Approval-First Import](https://github.com/liulinlin718-netizen/approval-first-import) | 为 Skill/MCP 导入提供内容绑定的风险预览与显式确认门 | `node bin/approval-first-import.js demo` |
| [Evidence-Bound Review](https://github.com/liulinlin718-netizen/evidence-bound-review) | 在给定办公材料范围内检查明确约束冲突并返回原文证据 | `node src/cli.js examples/project.json` |

每个目录包含独立源码、README、类型声明、合成示例、测试、MIT 许可证和来源说明。要求 Node.js 22 或更高版本，无需模型密钥或 TAgent 账户。

## 设计原则

- **证据优先**：缺失、歧义和未知不会被猜测成成功。
- **操作分离**：发现、预览、保存与执行使用不同授权边界。
- **本地可用**：默认读取本地合成数据，不联网、不调用模型。
- **范围诚实**：每个工具只处理自己的契约，不冒充完整平台或通用事实核查器。
- **容易集成**：零运行时依赖，提供 ESM API、类型声明和 CLI 示例。

## 使用边界

- Agent Trace Kit 分析生产者提供的日志，但日志本身不是防篡改审计证据。
- Approval-First Import 提供确认契约，但身份认证、网络抓取、安全保存和执行沙箱由宿主负责。
- Evidence-Bound Review 检查有限规则，不验证外部事实；未命中规则不等于全文正确。
- 三个工具都不会自动执行外部命令、安装包、发送消息或读取 TAgent 私有数据。

各工具的输入契约、示例和安全说明请参阅对应仓库 README。
