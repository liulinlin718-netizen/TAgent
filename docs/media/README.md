# README Media / README 媒体说明

These are screenshots of the actual TAgent Web UI, rendered locally with public synthetic display data. They are not mockup images and contain no user conversations, API keys or private files.

这些图片来自本地真实 TAgent Web 界面，仅填充公开的合成演示数据；不是设计稿，也不包含用户会话、API 密钥或私人文件。

| File / 文件 | What it shows / 内容 |
| --- | --- |
| `workspace.png` | Three-column conversation and workflow / 三栏对话与工作流 |
| `agent-hall.png` | Built-in Agent Cards, estimated scores and Skill binding / 内置角色、静态评分与 Skill 绑定 |
| `workflow-architecture.png` | Two-agent handoff, dependency edges, tool and governance nodes / 双 Agent 交接、依赖边、工具与治理节点 |
| `agent-bindings.png` | Skill selection and separate MCP binding/call permissions / Skill 勾选与独立 MCP 绑定、调用权限 |
| `skill-builder.png` | Unsaved manual Skill draft with SOP and checklist / 未保存的手工 Skill 草稿，含 SOP 与检查清单 |

The revenue brief and workflow events are display fixtures, not results of an executed model task. Agent Cards and Skill names come from the built-in definitions. Scores are explicitly static estimates. API requests are intercepted; no live backend, model, external search or mailbox is accessed.

营收简报与工作流事件仅为界面示例，并非已执行的模型任务。Agent Card 与 Skill 名称取自内置定义；评分明确为静态估算。截图脚本拦截 API，不连接真实后端、不调用模型、搜索或邮箱。

The extra binding and editor views use the real UI controls with unsaved changes. The MCP service is a synthetic display entry with no endpoint. The hand-written revenue Skill is not saved. Every non-GET API request is blocked. Diagram arrows explain capability and dependency relationships, not verified execution or factual certification.

挂载与编辑截图操作真实 UI 控件，但修改均未保存。MCP 服务只是没有端点的合成展示项，手工营收 Skill 没有落盘。所有非 GET API 请求均被阻止。流程图表达能力或依赖关系，不是执行回执或事实认证。

## Reproduce / 复现

From the repository root, prepare the display data:

在仓库根目录生成演示数据：

```powershell
node --import tsx scripts/readme-visuals-fixture.mts
```

Start only the frontend in a separate terminal / 另开终端，仅启动前端：

```powershell
cd packages/tagent-web
node node_modules/next/dist/bin/next dev --hostname 127.0.0.1 --port 3210
```

Use an installed Playwright CLI in a dedicated browser session, from the repository root / 在仓库根目录使用已安装的 Playwright CLI 和独立浏览器会话：

```powershell
playwright-cli -s=readme-publish open about:blank --browser chrome
playwright-cli -s=readme-publish run-code --filename=output/playwright/readme-capture.js
playwright-cli -s=readme-publish close
```

The capture template uses `G:/tagent/output/playwright/` for output. Adjust these output paths for a different checkout; all rendered data remains synthetic. Inspect the images before copying them into `docs/media/`. Stop the temporary frontend when done. GitHub renders the additional Mermaid diagrams directly from each README without a video player or external service.

截图模板的输出路径为 `G:/tagent/output/playwright/`；在其他机器上可调整该输出路径，不需连接真实数据。检查图片后再复制到 `docs/media/`，完成后停止临时前端。README 中其余 Mermaid 图由 GitHub 直接渲染，无需视频播放器或外部服务。
