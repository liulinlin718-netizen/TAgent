# 参考笔记：Agent-Browser + Playwright

> 来源：[agent-browser (Vercel Labs)](https://www.npmjs.com/package/agent-browser) · AI-native 浏览器自动化
> 定位：TAgent 的内置浏览器工具

---

## Agent-Browser 是什么

Vercel Labs 开发的 AI 专用浏览器 CLI，底层基于 Playwright。

| 特性 | 说明 |
|------|------|
| **Snapshot + Refs** | 不传完整 DOM，提取交互元素并编号（`@e1`, `@e2`） |
| **Token 节省** | 相比传完整 DOM/Accessibility Tree，token 消耗降低 90%+ |
| **安装** | `npm install -g agent-browser && agent-browser install` |
| **引擎** | Playwright 驱动 Chromium |

---

## 在 TAgent 中的定位

**作为内置 Tool**（非 MCP Server、非独立 Agent）：

| 方案 | 判断 |
|------|------|
| 内置 Tool ✅ | 延迟低、控制力强、可深度集成到 Agent Loop |
| MCP Server | 增加网络开销，浏览器状态管理复杂 |
| 独立 Agent | 过度抽象，浏览器是工具而非角色 |

---

## 安全治理配合

浏览器操作涉及安全治理，需配合治理引擎：

- URL 白名单 / 黑名单
- 下载行为控制
- 敏感信息检测（页面中的 PII）

---

## 典型使用场景

| 场景 | Agent | 操作 |
|------|-------|------|
| 竞品分析 | 研究 Agent | 浏览竞品网站，提取信息 |
| 数据采集 | 数据 Agent | 登录内部系统，导出报表 |
| 表单填写 | 文档 Agent | OA 系统提交审批 |
| 信息检索 | 任意 Agent | 搜索并汇总网上资料 |

---

## 对 TAgent 的启发总结

1. **Snapshot + Refs** 大幅降低 token 成本，适合资源治理约束
2. 定位为**内置 Tool**，Phase 2 集成
3. 需配合**安全治理协议**（URL 控制、下载控制）
4. 浏览器操作应记录到 **Trace** 中（含可选截图）
