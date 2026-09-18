# TAgent 独立小工具

从 TAgent 的实际办公协作问题提取，不是三个新产品，也不改变主项目运行依赖。每个子目录可以独立复制使用，包含自己的说明、MIT 许可证、来源说明、类型声明、合成示例和离线测试。三个项目已于 2026-09-18 分别上传 GitHub 公开仓库；尚未发布 npm 包，npm 名称可用性未查询。

## 独立仓库

- [Agent Trace Kit](https://github.com/liulinlin718-netizen/agent-trace-kit)
- [Approval-First Import](https://github.com/liulinlin718-netizen/approval-first-import)
- [Evidence-Bound Review](https://github.com/liulinlin718-netizen/evidence-bound-review)

独立仓库仅包含各自源码、文档、合成示例和测试，不携带主项目 Git 历史、真实会话、配置或凭据。本目录保留此次提取源码，后续独立工具更新请以各自仓库为准。

| 项目 | 解决的问题 | 最小使用方式 |
| --- | --- | --- |
| [Agent Trace Kit](./agent-trace-kit/README.md) | 将 JSONL 执行记录整理为任务、阶段、父子关系与工具调用；缺失和歧义不假装成功 | `node bin/agent-trace.js summary examples/research.jsonl` |
| [Approval-First Import](./approval-first-import/README.md) | 把候选发现、风险预览与确认保存分开；内容变更、过期和重复确认不能复用许可 | `node bin/approval-first-import.js demo` |
| [Evidence-Bound Review](./evidence-bound-review/README.md) | 检查有限范围的办公材料矛盾，返回规则和原文位置，不以模型自评代替证据 | `node src/cli.js examples/project.json` |

以上命令在对应子目录执行。最后一个示例故意包含矛盾，退出码 1 表示找到问题，并非程序故障。Node >=22，无需安装依赖、模型密钥或账户。

## 验证与边界

2026-09-18，Windows / Node 24.13.1 本地复跑通过：Trace 45 项、Import 34 项、Review 95 项，共 174 项；各子任务也完成了已有 TypeScript 工具下的声明检查。没有联网、付费请求、真实会话或凭据文件，不代表所有 Node 版本和平台矩阵已测试。

独立分发补查：GitHub 发布前的三个本地候选已离线生成 `.tgz`，总计50,950字节，解包后仅授予读取各自包目录的权限，三个CLI示例均取得预期结果，没有引用TAgent依赖或数据。此为补充仓库元数据之前的打包记录，不代表最新远端提交的包大小或哈希。验收产物仅保留在本机 `output/opensource/`，不上传源码仓库；临时解包目录和本次打包缓存已清理。未发布 npm 包。

- Trace 是日志分析，不是防篡改审计，也不能证明工具实际成功或账单完整。
- Import 是单进程确认契约，不是身份认证、恶意代码检测或执行沙箱；宿主仍负责安全保存和另行执行授权。
- Review 是明确规则范围内的检查，不是通用事实核查。未发现问题不代表全文正确；日期元数据真实性由上游负责。
- 独立库不是主项目的原位替换。特别是日期窗口定义、兼容事件形状和持久化接口，接入前需对齐各项目的契约。
- 发布前检查许可证、项目名和包内容；不要打包 TAgent 的 `.env`、`.tagent`、真实日志、Git 历史、依赖或测试浏览器资料。

开发任务已分别建立：`开源提取：Agent Trace Kit`、`开源提取：Approval-First Import`、`开源提取：Evidence-Bound Review`。此次 GitHub 上传经用户明确授权，不包含 npm 发布或扩展成完整产品。
