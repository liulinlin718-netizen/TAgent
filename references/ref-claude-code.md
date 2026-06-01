# 参考笔记：Claude Code

> 来源：Anthropic Claude Code · 最成熟的 AI 编码 Agent
> 定位：单主循环 + 子 Agent 委派 + 三层记忆 + 动态 Prompt

---

## 架构：Orchestrator + Subagent

核心是一个 `while(true)` 主循环：**Gather → Act → Observe**

### 子 Agent 委派模型（Hub-and-Spoke）

| 特性 | 设计 |
|------|------|
| 隔离 | 子 Agent 有独立上下文窗口，不共享主对话 |
| 专用 | 每个子 Agent 有专属 system prompt + 工具白名单 |
| 扁平 | **子 Agent 不能再创建子 Agent**（只有一层） |
| 返回 | 子 Agent 只返回最终摘要/结果给主 Agent |

**启发**：Claude Code 限制了子 Agent 不能递归——这是我们的差异化所在。但它的隔离上下文 + 只返回摘要的模式值得学习，可以防止上下文窗口膨胀。

### 并行探索

- 可同时派出多个 "Explore" 子 Agent 搜索不同模块
- Explore Agent 用更便宜的模型（如 Haiku），只读权限
- 结果汇总回主 Agent

**启发**：我们的裂变 Agent 也应支持"只读探索"模式，用低成本模型。

---

## 三层记忆系统

| 层级 | 文件 | 作用域 | 特点 |
|------|------|--------|------|
| 项目级 | `CLAUDE.md` (项目根) | 团队共享 | 架构决策、编码规范、构建命令 |
| 用户级 | `~/.claude/CLAUDE.md` | 个人 | 偏好设置、本地环境 |
| 自动学习 | Auto Memory | 自动 | 从纠错中学习，周期性保存 |

**上下文管理策略**：
- `/compact` — 压缩对话历史（保留关键点）
- `/clear` — 切换任务时清空上下文
- 建议 CLAUDE.md 控制在 200-300 行以内
- 用 `.claude/rules/` 按路径模块化加载

**启发**：
1. 三层记忆（项目/用户/自动学习）可以直接映射到我们的记忆系统
2. `/compact` 思路 → 我们的"摘要 Fork"
3. 模块化规则按路径加载 → 我们的 Skills 匹配机制

---

## 动态 Prompt 组装

子 Agent 定义在 `.claude/agents/` 目录，YAML/Markdown frontmatter 格式：
- 定义身份、system prompt、可用工具
- 主 Agent 根据任务匹配子 Agent → 组装初始 prompt → 派遣

**启发**：我们的 Agent Card 可以采用类似的声明式定义方式。

---

## "Rush Bias" 教训

Claude Code 早期存在"急于行动"的倾向——直接开始写代码而不够验证。

**启发**：我们的治理引擎的"方向治理"协议正是为了解决这个问题。Agent 执行前应有规划验证步骤。

---

## 对 TAgent 的启发总结

1. **隔离上下文 + 摘要返回**是多 Agent 的关键模式
2. **三层记忆**可直接采用，增加"自动学习"能力
3. **声明式 Agent 定义**（frontmatter）适合我们的 Agent Card
4. 通过治理引擎避免 "Rush Bias"
