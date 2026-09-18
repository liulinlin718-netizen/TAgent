# 执行记录与 JSONL 索引

更新：2026-09-13。执行记录用于让用户核对任务做了什么，不代表独立事实审核或不可篡改审计。

## 用户体验

- 已结束的任务展开“执行记录”后，按40条加载明细，可按协作者、行为筛选、继续加载、查看事件数据和手动刷新。
- 收起时不查询、不轮询。筛选或切换会话会取消上一请求，迟到结果不能替换当前任务记录。
- 读取失败保留已加载记录并提供重试；索引代次改变后需要刷新，不将失效游标解释为“没有事件”。
- 运行中的进度继续使用 SSE。完整架构图、实时流转和右侧事件日志仍使用同一份完整 WorkflowEvent，不以某一页替代整个工作流。
- 旧版具有真实 eventId/sessionId/runId 的记录可回查；没有这些标识或 Fork 引用原任务的消息继续显示原有记录，不伪造新 run。
- 普通用户看到中文角色、行为和状态；原始事件标识与数据放在可展开明细里。

## 存储契约

会话消息及 RunJournal 检查点仍是权威数据。新增 `.tagent/workflow-index/` 是可重建的派生副本，不改写用户历史来“迁移”，也不重跑模型或工具。

每个 workspace/session/run 使用三元组 SHA-256 文件名，不将用户输入拼接为文件路径：

```text
<scope-hash>.index.json
<scope-hash>.<generation-uuid>.jsonl
```

- JSONL保存原始统一事件，按UTF-8字节偏移读取，不按中文字符长度计算偏移。索引记录事件ID、类型、Agent、偏移、长度和SHA-256。
- 后台写入按run串行，单run最多32项待写；超限或磁盘错误停止本轮后台索引，并记录警告。索引不阻断最终报告、审批或保存原始任务。之后查询可补齐已保存事件。
- 写入先追加JSONL并同步，再原子替换索引文件。重启可截掉没有索引提交的尾部；已提交前缀不原地改写。源记录修正或索引损坏时生成新代次，提交后清理旧副本。
- 查询对本页字节做校验。数据校验失败返回503；用户刷新后依据原始记录重建。目录/文件为符号链接或异常类型时拒绝写入，不沿链接访问外部目录。
- 索引缓存最多64个run；单run最多50000条/128MiB，单条事件最多512KiB。页内事件正文合计最多1MiB，上限触发时给出错误，不截断事件冒充完整数据。
- 游标绑定完整归属、筛选、代次及首屏事件数量。新增事件不挤动后续页；刷新后才纳入新事件。代次不一致返回409。
- 删除会话/工作空间后撤销查询并清理其索引。清理失败会返回明确warnings，主对话删除操作会显示警告，不声称本地副本已全部删除。

## API

所有入口沿用实例访问控制，不是新的公开匿名接口。

| 入口 | 行为 |
| --- | --- |
| `GET /api/workspaces/:wsId/sessions/:sessId/traces` | 列出该会话可回查的run及事件数量 |
| `GET /api/workspaces/:wsId/sessions/:sessId/traces/:runId` | 分页统一事件；支持`agentId`、`type`、`limit`、`cursor` |
| `GET /api/trace/:sessionId?runId=...` | 兼容入口，`entries`与`events`相同；多个run时必须指定runId |

返回共享 `WorkflowTracePage`：归属、events、total、available、nextCursor、agents/types筛选项、persisted、rebuilt。`total`是当前分页快照的筛选总数，`available`是索引当前完整数量。`limit`默认40，允许1至100。

不存在或归属不匹配的任务返回404，且不创建目录或文件；无效参数/游标返回400。接口等待期间来源被删除，不再返回其内容。

## 验证

先构建Core和Server，再运行：

```powershell
pnpm exec vitest run
node --import tsx scripts/verify-workflow-history.mts
node scripts/verify-access-control.mjs
node scripts/verify-tool-approval.mjs
```

- 当前70个测试文件、778项回归通过。新增覆盖字节偏移、分页、同run追加、跨归属、游标快照、恢复、损坏、活动终态修正、目录链接拒绝及清理告警。
- 隔离真实后端：132条固定长任务事件逐条一致，重启保留游标；两个SSE运行入口分别到达唯一终态，分页结果与SSE及保存消息一致，删除后不可读取。
- 浏览器：`verify-workflow-history.mts --serve`输出临时base；专用页面使用`runFixture`和`scripts/fixtures/tool-approval-browser.js`路由API后，执行`scripts/verify-workflow-history-browser.js`。验证折叠零请求、每次完成加载40条、筛选、故障保留/重试、完整架构不受分页影响及刷新中文。脚本没有API写入。
- 已检查1440、390、320宽度截图；修复架构卡片重复工具标签引发的React key警告。故意注入的503之外没有浏览器错误。

上述SSE使用固定验收模式，不调用外部模型、网络搜索或付费API；不是实际调研质量证明。

## 尚未完成

这不是完整规模化Trace平台：会话接口仍携带原始完整Trace，工作区/消息存储仍为整份快照。当前只对展开明细做按需查询与DOM分页，未完成初始会话网络载荷裁剪、服务端图摘要或右侧全量日志虚拟化。

治理页与Trace共用按Store提交版本缓存的WorkflowCatalog，但治理统计仍从快照聚合，不是数据库索引查询。JSONL事件正文追加不代表整个写入O(1)，偏移元数据仍需原子重写；初次重建需扫描该run，Store版本改变也需更新目录。原计划的PostgreSQL索引、多进程写入、日志保留/清理重试、备份恢复、磁盘长期挂起、200+节点性能及不可篡改审计仍需独立实现与验收。

整体发布门槛继续以[上线验收清单](./release-readiness.md)为准。
