# Agent Trace Kit

[中文](./README.md) | [English](./README_EN.md)

Agent Trace Kit 是一个零依赖的 Node.js 库和 CLI，用于校验、整理与查询以 JSONL 保存的 Agent 工作流事件。它把原始事件还原为清晰的运行、任务 Agent、执行阶段、父子关系、工具调用、结果和已记录成本，帮助开发者理解 Agent 到底做了什么。

它适合 Agent 平台、自动化系统和本地调试工具使用。遇到缺失或相互冲突的证据时，Agent Trace Kit 会明确标记未知与歧义，而不是猜测一个看似完整的执行故事。

[快速开始](#快速开始) · [示例解读](#示例解读) · [作为库使用](#作为库使用) · [安全与边界](#安全与边界)

## 为什么需要它

Agent 运行通常会同时产生流式事件、工具调用、子任务和治理记录。仅查看原始日志很难回答这些问题：

- 一次运行是否真正结束，还是在中途停止？
- 哪个 Agent 创建了子任务，哪些 Agent 只是参与者？
- 工具调用是否获得了对应结果？
- 是否存在重放、重复 ID、冲突状态或未结算成本？
- 前端工作流、审计页面和调试 CLI 能否基于同一份事实？

Agent Trace Kit 为这些问题提供一个保守、可复用的事件模型。

## 核心能力

- 校验规范化工作流事件，并隔离身份冲突的记录。
- 对重放事件去重，同时保留冲突诊断。
- 按 workspace、session、run、task、agent 和事件类型精确过滤。
- 将事件归入稳定的执行阶段。
- 只根据已记录证据构建父子与参与关系。
- 关联工具调用和结果，包括乱序到达的事件。
- 识别未完成运行、冲突结果、未配对工具调用和未知成本。
- 提供内存索引、偏移分页、文本摘要和 JSON 输出。

该工具只读取本地数据，不调用模型、不访问 URL、不执行工具、不重放工作流，也不发送遥测。

## 工作原理

```mermaid
flowchart LR
    A[WorkflowEvent JSONL] --> B[校验与规范化]
    B --> C[去重与冲突隔离]
    C --> D[运行 / Agent / 阶段模型]
    D --> E[工具调用关联]
    D --> F[关系与结果]
    C --> G[索引与分页]
    E --> H[API / CLI 输出]
    F --> H
    G --> H
```

## 快速开始

要求 Node.js 22 或更高版本，无需安装依赖或构建。

```bash
git clone https://github.com/liulinlin718-netizen/agent-trace-kit.git
cd agent-trace-kit

node bin/agent-trace.js summary examples/research.jsonl
node bin/agent-trace.js validate examples/research.jsonl --json
node bin/agent-trace.js events examples/research.jsonl --run research-run --limit 20 --json
```

仓库中的示例为合成数据，包含完成与中断运行、事件重放、父子关系和未配对工具调用。

## 示例解读

下面的图根据仓库公开的 [research.jsonl](./examples/research.jsonl) 整理，展示记录中的父子关系和工具调用归属。它是**合成 Trace 的说明图，不是应用截图，也不代表本工具执行了联网搜索**。

```mermaid
flowchart TB
    subgraph Research["research-run · 生产者声明 succeeded"]
        Coordinator["coordinator<br/>task: planning"] -->|父子关系| Researcher["researcher<br/>task: research"]
        Researcher -->|调用| SearchOne["web_research · search-1<br/>returned · 30 ms"]
        Researcher -->|调用| SearchTwo["web_research · search-2<br/>returned · 10 ms"]
    end
    subgraph Interrupted["interrupted-run · 生产者声明 interrupted"]
        Reader["researcher<br/>task: read"] -->|调用| Pending["read_url · read-1<br/>pending · 时长未知"]
    end
    classDef agent fill:#E8F2FA,stroke:#5982A3,color:#163247
    classDef returned fill:#EBF8F1,stroke:#478B65,color:#143827
    classDef unknown fill:#FFF4DC,stroke:#AA7C2A,color:#533C16
    class Coordinator,Researcher,Reader agent
    class SearchOne,SearchTwo returned
    class Pending unknown
```

这份示例为什么有用：

| 原始日志中的情况 | 分析结果 |
| --- | --- |
| 输入 15 条记录，其中 `e07` 被重放一次 | 接受 14 条，记录 1 次重复，不重复计数 |
| `search-2` 比 `search-1` 先返回 | 用 `callId` 正确关联，分别记录 10 ms 和 30 ms，不按返回顺序猜测 |
| 研究 Agent 有明确的父 Agent 与父任务 | 生成 coordinator → researcher 的父子边 |
| `read_url` 尚未记录结果，运行已经中断 | 调用保持 `pending`，运行保持 `interrupted`，不补造结果 |
| 完成记录包含总成本 `0.003` | 显示已记录总额，不累加 Agent 成本，也不换算成账单 |
| 某来源的发布日期未知 | 保留治理警告，不把“已返回”视为已验证内容 |

运行快速开始中的 `summary` 命令，可得到以下真实终端输出节选；省略行不影响这些数值：

```text
Agent Trace Kit
Events: 14 accepted; 1 duplicate copies; 0 invalid; 0 conflicting identities.

Run interrupted-run | session demo-session | interrupted
  Recorded run cost: unknown (not a billing total)
  Tool read_url | task read | call read-1 | pending | none | duration unknown | outcome unknown

Run research-run | session demo-session | succeeded
  Recorded run cost: 0.003 (not a billing total)
    Parent: coordinator[planning] -> researcher[research]
  Tool web_research | task research | call search-1 | returned | call_id | 30 ms | outcome unknown
  Tool web_research | task research | call search-2 | returned | call_id | 10 ms | outcome unknown
```

`returned` 表示结果记录存在，不代表搜索内容正确；示例没有为工具声明成功，所以工具的 `outcome` 仍是 `unknown`。运行级 `succeeded` 也只是生产者声明，不是对任务质量的独立认证。

## 作为库使用

```js
import {
  readTraceFile,
  createTraceIndex,
  analyzeCollectedTrace,
} from './src/index.js';

const trace = await readTraceFile('./examples/research.jsonl');
const report = analyzeCollectedTrace(trace);

const index = createTraceIndex(trace);
const page = index.query(
  { sessionId: 'demo-session', runId: 'research-run' },
  { offset: 0, limit: 100 },
);

console.log(report.runs);
console.log(report.counts, report.issues);
console.log(page.events);
```

项目提供 ESM 导出和 TypeScript 类型声明。

只需要文件摘要时，可以使用一个入口：

```js
import { analyzeTraceFile } from './src/index.js';

const report = await analyzeTraceFile('./examples/research.jsonl', {
  filter: { runId: 'research-run' },
});
console.log(report.filtered, report.selectedEventCount, report.issues);
```

传递整个 `trace` 可保留原始计数、诊断和行号/字节定位，并复用已校验数据。过滤摘要会明确标记为部分证据；即使筛掉问题事件，原始输入诊断也不会消失。

`trace` 是库创建的只读批次，每次读取其属性都返回副本。`trace.evidence` 保留原始规范化记录（含重复与冲突版本）及来源位置，可能包含工具参数或私密数据，CLI 不会直接输出它。使用批次本身进行组合，不要传递展开/克隆后的普通对象。原始内存事件仍可用 `summarizeTrace(events)`；低层 `modelForEvents` 仅适用于已排序、去重且规范化的数据。

## 事件格式

每一行 JSONL 是一个 JSON 对象：

```json
{
  "eventId": "event-4",
  "sessionId": "session-1",
  "runId": "run-1",
  "taskId": "research-1",
  "agentId": "researcher",
  "type": "agent_tool_call",
  "timestamp": 1770000000000,
  "summary": "Read a public page.",
  "toolName": "read_url",
  "callId": "call-7"
}
```

必填字段为 `eventId`、`type` 和 `summary`。事件身份由 `(workspaceId, sessionId, runId, eventId)` 组成；同一身份的冲突记录会被排除并报告，不会静默采用先写或后写版本。

根字段与支持的 `data` 身份/工具别名按相同语义去重，规范事件只保留提升后的字段；其他扩展数据和工具参数仍参与冲突判断。所有冲突版本的重放均计入重复数，不因输入顺序不同而改变。

## 工具调用、关系与结果

工具调用只在相同 run、task、agent 和 tool 范围内配对：优先使用唯一 `callId`；没有 `callId` 的旧事件仅在存在唯一未关闭调用时配对。重用 ID、范围缺失和工具名冲突都会保持为歧义状态。

父子边要求同一运行中存在唯一父节点。缺失父节点、冲突声明和循环关系会被报告，而不会被渲染成虚构关系。运行结果来自明确的完成、失败、中断或取消事件；没有终止事件的运行标记为 `incomplete`。

缺少 `runId` 时，事件只放入 `scopeStatus: 'unassigned'` 的未归属集合：不关联父子/参与边或工具调用，不合并 Agent 实例，汇总结果和费用保持未知。若调用者确实知道运行身份，应在输入前显式补充正确的 `runId`，不能用随机值猜测。矛盾的成功声明会产生 `conflicting_outcome`；互相冲突的运行费用会产生 `conflicting_run_cost`，总额返回 `null`，候选值保留在 `costEvidence`。

工具结果事件只证明日志中记录了结果，不证明外部操作成功或返回内容正确。成本同样只读取明确字段，不推算供应商账单、汇率或缺失费用。

## CLI

```text
agent-trace summary <file> [filters] [--json]
agent-trace validate <file> [--json]
agent-trace events <file> [filters] [--offset N] [--limit N] [--json]
```

过滤条件包括 workspace、session、run、task、agent 和事件类型。CLI 只读取指定文件，并向 stdout/stderr 输出结果。

退出码：

- `0`：结构有效；其中仍可能包含生产者报告的失败任务。
- `2`：发现无效或冲突记录。
- `1`：参数、文件访问、文件变化或资源限制错误。

## 安全与边界

- 默认最多处理 50,000 个事件和 32 MiB 输入。
- 使用严格 UTF-8；错误 JSON 会被报告，不会自动修复。
- CLI 拒绝符号链接和非普通文件。
- 未知时间、身份、结果和成本保持未知。
- 日志可能包含隐私数据或密钥，共享前应先审查。
- JSONL 不是防篡改审计证据，事件生产者可能遗漏或错误记录信息。

本项目是 Trace 分析组件，不是 Orchestrator、执行器、沙箱、授权系统、事实核查器或质量 Benchmark。

## 测试与贡献

```bash
node --test test/*.test.js
```

测试只使用 Node.js 内置模块和本地合成数据。欢迎通过 [Issues](https://github.com/liulinlin718-netizen/agent-trace-kit/issues) 提交可复现问题；贡献代码时请保持证据语义保守，并为事件边界补充测试。

## 许可

[MIT License](./LICENSE)。设计提取自 TAgent 的规范工作流事件与任务实例模型，并重写为独立工具；来源说明见 [NOTICE](./NOTICE)。
