# TAgent 前端参考文档索引

> 本文件夹包含三个网站的前端设计参考分析，用于 TAgent 前端开发指导。

## 参考网站列表

| # | 网站 | 文档 | 设计风格 | 核心可借鉴元素 |
|---|------|------|---------|--------------|
| 1 | [x.ai](https://x.ai/) | [01-xai-reference.md](./01-xai-reference.md) | 极简科技、Aurora 光晕、黑白高对比 | Glassmorphism 导航、能力卡片 Grid、Split Button、代码编辑器窗口 |
| 2 | [converge.ai](https://converge.ai/) | [02-converge-ai-reference.md](./02-converge-ai-reference.md) | 超极简、点阵图案、宇宙蓝光晕 | 搜索输入框交互、点阵图标系统、深色 Banner、统计仪表板 |
| 3 | [mycalmsite.com](https://mycalmsite.com/) | [03-mycalmsite-reference.md](./03-mycalmsite-reference.md) | 沉浸式冥想、玻璃态、呼吸动画 | 脉动动画(Pulse Flow)、双主题系统、玻璃态面板、环境声控制 |

## TAgent 前端设计综合建议

### 从三个网站提炼的核心设计模式

1. **Glassmorphism 毛玻璃效果** — x.ai + mycalmsite 均使用，适合 TAgent 导航栏和浮动面板
2. **胶囊形按钮** — 三个网站统一使用 `border-radius: 9999px`，现代感强
3. **CSS 变量驱动主题** — mycalmsite 的双主题方案最完整，建议 TAgent 采用
4. **脉动/呼吸动画** — mycalmsite 的呼吸球可直接转化为 Agent Pulse Flow
5. **深色宇宙区块** — converge.ai 的行星光晕效果适合 Agent "深度思考"状态
6. **代码展示窗口** — x.ai 的编辑器组件适合展示 Agent 代码执行
7. **统计数据展示** — converge.ai 竖线分隔 + x.ai 网格背景的混合方案

### 推荐字体组合

```css
--font-primary: 'Inter', 'Instrument Sans', sans-serif;  /* UI 文字 */
--font-mono: 'JetBrains Mono', 'Fira Code', monospace;   /* 代码展示 */
```
