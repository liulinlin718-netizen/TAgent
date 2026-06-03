# x.ai 前端参考文档

> **网站地址**: https://x.ai/  
> **分析日期**: 2026-06-03  
> **设计风格**: 极简科技感、Aurora 光晕边框、高对比黑白主题

---

## 1. 整体布局结构

```
┌─────────────────────────────────────────────────┐
│  Sticky Header (Logo + Nav + CTAs)              │
├─────────────────────────────────────────────────┤
│  Hero Section                                   │
│  ┌─ Badge Pill ─────────────────────────────┐   │
│  │ "New Grok Build Beta"                    │   │
│  └──────────────────────────────────────────┘   │
│  大标题: "Frontier AI models for everything"     │
│  副标题 + 双CTA按钮                              │
├─────────────────────────────────────────────────┤
│  Capabilities Grid (2x2)                        │
│  ┌─────────┐ ┌─────────┐                       │
│  │  Chat   │ │  Build  │                       │
│  ├─────────┤ ├─────────┤                       │
│  │ Imagine │ │  Voice  │                       │
│  └─────────┘ └─────────┘                       │
├─────────────────────────────────────────────────┤
│  Developer Section (双栏: 文字 + 代码编辑器)      │
├─────────────────────────────────────────────────┤
│  Stats Grid (超大数字 + 网格背景)                 │
├─────────────────────────────────────────────────┤
│  Latest News (4列卡片)                           │
├─────────────────────────────────────────────────┤
│  Get Started / Pricing (双卡片对比)               │
├─────────────────────────────────────────────────┤
│  Footer (多列链接)                               │
└─────────────────────────────────────────────────┘
```

### 关键特征
- 页面外围有 **蓝紫色 Aurora 光晕边框**，营造桌面应用质感
- 所有卡片/按钮大量使用 `rounded-2xl` 或 `rounded-full` 圆角
- 单页滚动式布局，各区块间距充裕

---

## 2. 设计令牌 (Design Tokens)

### 颜色系统

```css
:root {
  /* 背景色 */
  --bg-canvas: #FFFFFF;
  --bg-card: #F4F4F5;           /* neutral-50 */
  --bg-card-alt: #F0F0F2;       /* neutral-100 */
  --bg-dark: #09090B;           /* 深色卡片 */

  /* 文字色 */
  --text-primary: #09090B;      /* 标题/正文 */
  --text-secondary: #71717A;    /* 副标题/描述 */
  --text-muted: rgba(9,9,11,0.5); /* 辅助文字 */

  /* 强调色 */
  --accent-orange: #F97316;     /* Badge 边框 */
  --accent-gold: #EAB308;       /* Hero 文字下划线 */
  --accent-aurora-blue: rgba(99,102,241,0.3);  /* 光晕 */
  --accent-aurora-purple: rgba(168,85,247,0.2);

  /* 边框与阴影 */
  --border-subtle: rgba(9,9,11,0.06);
  --border-hover: rgba(9,9,11,0.15);
  --shadow-card-hover: rgba(9,9,11,0.03);
}
```

### 字体系统

```css
:root {
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;

  /* 字号层级 */
  --text-hero: clamp(2.5rem, 5vw, 4rem);    /* Hero 标题 */
  --text-section: clamp(1.875rem, 3vw, 2.5rem); /* 板块标题 */
  --text-body: 1rem;
  --text-sm: 0.875rem;
  --text-xs: 0.75rem;
  --text-code: 0.8125rem;       /* 13px 代码字体 */
}
```

---

## 3. 核心组件代码参考

### 3.1 导航栏 (Sticky Header + Glassmorphism)

```html
<header class="header">
  <div class="header__left">
    <a href="/" class="header__logo" aria-label="xAI Homepage">
      <span class="logo-text">xAI</span>
    </a>
    <nav class="header__nav">
      <a href="/grok" class="nav-link">Products</a>
      <a href="/solutions" class="nav-link">Solutions</a>
      <a href="/api" class="nav-link">Developer</a>
      <a href="/company" class="nav-link">Company</a>
      <a href="/pricing" class="nav-link">Pricing</a>
      <a href="/news" class="nav-link">News</a>
    </nav>
  </div>
  <div class="header__actions">
    <a href="/contact-sales" class="btn btn--ghost">Contact Sales</a>
    <div class="btn-split">
      <a href="https://grok.com/" class="btn-split__main">Try for free</a>
      <button class="btn-split__dropdown" aria-label="More options">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
    </div>
  </div>
</header>
```

```css
.header {
  position: sticky;
  top: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-subtle);
}

.header__logo { display: flex; align-items: center; }
.logo-text {
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  color: var(--text-primary);
}

.header__nav {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  margin-left: 2rem;
}

.nav-link {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.15s ease;
}
.nav-link:hover { color: var(--text-primary); }

/* Ghost 按钮 */
.btn--ghost {
  display: inline-flex;
  align-items: center;
  padding: 0.5rem 1rem;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-primary);
  background: transparent;
  border: 1px solid var(--border-hover);
  border-radius: 9999px;
  transition: background 0.15s ease;
  text-decoration: none;
}
.btn--ghost:hover { background: rgba(9,9,11,0.05); }

/* 分裂按钮 (Split Button) */
.btn-split {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  background: var(--text-primary);
  color: #fff;
  overflow: hidden;
}
.btn-split__main {
  padding: 0.5rem 0.75rem 0.5rem 1rem;
  font-size: var(--text-sm);
  font-weight: 500;
  color: inherit;
  text-decoration: none;
  transition: background 0.15s;
}
.btn-split__main:hover { background: rgba(255,255,255,0.1); }
.btn-split__dropdown {
  padding: 0.5rem 0.75rem 0.5rem 0.5rem;
  border: none;
  border-left: 1px solid rgba(255,255,255,0.1);
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: background 0.15s;
}
.btn-split__dropdown:hover { background: rgba(255,255,255,0.1); }
```

### 3.2 Hero Section (动态文字 + 双CTA)

```html
<section class="hero">
  <!-- Badge Pill -->
  <a href="/blog/grok-build" class="hero__badge">
    <span class="badge-dot"></span>
    New Grok Build Beta
    <svg class="badge-arrow" width="12" height="12" viewBox="0 0 24 24"><path d="M5 12h14m-7-7l7 7-7 7"/></svg>
  </a>

  <!-- 大标题 -->
  <h1 class="hero__title">
    Frontier AI models for<br>everything you
    <span class="hero__cycling-word" id="cyclingWord">see</span>
  </h1>

  <!-- 副标题 -->
  <p class="hero__subtitle">
    From chat and search to image generation and coding,
    Grok is designed to be the most capable AI assistant.
  </p>

  <!-- CTA 按钮组 -->
  <div class="hero__ctas">
    <a href="https://grok.com/" class="btn btn--primary">Try Grok for free</a>
    <a href="/api" class="btn btn--ghost">View Documentation</a>
  </div>
</section>
```

```css
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 6rem 2rem 4rem;
  position: relative;
}

.hero__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 1rem;
  font-size: var(--text-xs);
  font-weight: 600;
  color: var(--text-primary);
  background: transparent;
  border: 1px solid var(--border-hover);
  border-radius: 9999px;
  text-decoration: none;
  margin-bottom: 2rem;
  transition: background 0.15s;
}
.hero__badge:hover { background: rgba(9,9,11,0.05); }
.badge-dot {
  width: 6px; height: 6px;
  background: var(--accent-orange);
  border-radius: 50%;
}

.hero__title {
  font-size: var(--text-hero);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--text-primary);
  margin-bottom: 1.5rem;
}

.hero__cycling-word {
  position: relative;
  display: inline-block;
}
.hero__cycling-word::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: -2px;
  height: 4px;
  background: var(--accent-gold);
  border-radius: 2px;
}

.hero__subtitle {
  font-size: 1.125rem;
  color: var(--text-secondary);
  max-width: 36rem;
  line-height: 1.6;
  margin-bottom: 2rem;
}

.hero__ctas { display: flex; gap: 0.75rem; }

.btn--primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.625rem 1.5rem;
  font-size: var(--text-sm);
  font-weight: 500;
  color: #fff;
  background: var(--text-primary);
  border: none;
  border-radius: 9999px;
  text-decoration: none;
  transition: opacity 0.15s;
}
.btn--primary:hover { opacity: 0.9; }
```

```javascript
// 文字循环动画
const words = ['see', 'build', 'imagine', 'hear'];
let index = 0;
const el = document.getElementById('cyclingWord');

setInterval(() => {
  el.style.opacity = 0;
  el.style.transform = 'translateY(8px)';
  setTimeout(() => {
    index = (index + 1) % words.length;
    el.textContent = words[index];
    el.style.opacity = 1;
    el.style.transform = 'translateY(0)';
  }, 300);
}, 3000);
```

### 3.3 能力展示卡片 (2×2 Grid)

```html
<section class="capabilities">
  <div class="capabilities__grid">
    <div class="cap-card" data-type="chat">
      <div class="cap-card__visual">
        <!-- 聊天气泡模拟 -->
        <div class="chat-bubble chat-bubble--user">What is quantum computing?</div>
        <div class="chat-bubble chat-bubble--ai">Quantum computing leverages...</div>
      </div>
      <div class="cap-card__footer">
        <span class="cap-card__label">Chat</span>
        <span class="cap-card__action">Explore →</span>
      </div>
    </div>

    <div class="cap-card cap-card--dark" data-type="build">
      <div class="cap-card__visual">
        <div class="terminal-mockup">
          <div class="terminal-dots"><span></span><span></span><span></span></div>
          <code class="terminal-code">$ grok build --deploy</code>
        </div>
      </div>
      <div class="cap-card__footer">
        <span class="cap-card__label">Build</span>
        <span class="cap-card__action">Explore →</span>
      </div>
    </div>

    <div class="cap-card" data-type="imagine">
      <div class="cap-card__visual"><!-- AI 图片画廊 --></div>
      <div class="cap-card__footer">
        <span class="cap-card__label">Imagine</span>
        <span class="cap-card__action">Explore →</span>
      </div>
    </div>

    <div class="cap-card cap-card--dark" data-type="voice">
      <div class="cap-card__visual">
        <div class="voice-waveform"><!-- 音频波形动画 --></div>
      </div>
      <div class="cap-card__footer">
        <span class="cap-card__label">Voice</span>
        <span class="cap-card__action">Explore →</span>
      </div>
    </div>
  </div>
</section>
```

```css
.capabilities { padding: 4rem 2rem; }
.capabilities__grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1.5rem;
  max-width: 72rem;
  margin: 0 auto;
}

.cap-card {
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  height: 280px;
  padding: 1.5rem;
  overflow: hidden;
  border-radius: 1rem;
  border: 1px solid var(--border-subtle);
  background: var(--bg-card);
  transition: all 0.5s ease;
}
.cap-card:hover {
  border-color: var(--border-hover);
  box-shadow: 0 10px 40px var(--shadow-card-hover);
}

.cap-card--dark {
  background: var(--bg-dark);
  color: #fff;
  border-color: rgba(255,255,255,0.06);
}

.cap-card__visual {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.8;
  transition: opacity 0.5s;
}
.cap-card:hover .cap-card__visual { opacity: 1; }

.cap-card__footer {
  position: relative;
  z-index: 10;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  width: 100%;
  margin-top: auto;
}

.cap-card__label {
  font-size: var(--text-sm);
  font-weight: 600;
}

.cap-card__action {
  font-size: var(--text-xs);
  color: var(--text-muted);
  transition: color 0.15s;
}
.cap-card:hover .cap-card__action { color: var(--text-primary); }
.cap-card--dark:hover .cap-card__action { color: #fff; }
```

### 3.4 Aurora 光晕边框效果

```css
/* 页面外围 Aurora 光晕 */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: 9999;
  pointer-events: none;
  background:
    radial-gradient(ellipse at 0% 50%, var(--accent-aurora-blue), transparent 50%),
    radial-gradient(ellipse at 100% 50%, var(--accent-aurora-purple), transparent 50%),
    radial-gradient(ellipse at 50% 100%, var(--accent-aurora-blue), transparent 40%);
  opacity: 0.6;
}
```

### 3.5 开发者区域 (代码编辑器风格)

```html
<section class="developer">
  <div class="developer__content">
    <div class="developer__info">
      <h2 class="section-title">One API.<br>Every modality.</h2>
      <p class="section-desc">Build with text, vision, and function calling.</p>
      <div class="developer__stats">
        <div class="stat"><span class="stat__number">1M+</span><span class="stat__label">API calls/day</span></div>
        <div class="stat"><span class="stat__number">100K+</span><span class="stat__label">Developers</span></div>
        <div class="stat"><span class="stat__number">99.9%</span><span class="stat__label">Uptime</span></div>
      </div>
    </div>
    <div class="developer__editor">
      <div class="editor-window">
        <div class="editor-titlebar">
          <div class="editor-dots"><span></span><span></span><span></span></div>
          <div class="editor-tabs">
            <button class="editor-tab active">Python</button>
            <button class="editor-tab">TypeScript</button>
            <button class="editor-tab">cURL</button>
          </div>
        </div>
        <pre class="editor-code"><code>from xai import Grok

client = Grok(api_key="your-key")
response = client.chat.completions.create(
    model="grok-3",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)</code></pre>
      </div>
    </div>
  </div>
</section>
```

```css
.developer {
  padding: 6rem 2rem;
  max-width: 72rem;
  margin: 0 auto;
}
.developer__content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3rem;
  align-items: center;
}

.editor-window {
  border-radius: 1rem;
  overflow: hidden;
  background: linear-gradient(135deg, #FED7AA, #FDBA74, #FB923C);
  padding: 2px;
}
.editor-titlebar {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1rem;
  background: rgba(255,255,255,0.9);
  backdrop-filter: blur(8px);
}
.editor-dots {
  display: flex; gap: 6px;
}
.editor-dots span {
  width: 12px; height: 12px;
  border-radius: 50%;
}
.editor-dots span:nth-child(1) { background: #EF4444; }
.editor-dots span:nth-child(2) { background: #EAB308; }
.editor-dots span:nth-child(3) { background: #22C55E; }

.editor-code {
  padding: 1.5rem;
  background: #1E1E2E;
  color: #CDD6F4;
  font-family: var(--font-mono);
  font-size: var(--text-code);
  line-height: 1.7;
  overflow-x: auto;
}
```

### 3.6 新闻卡片 (渐变背景)

```css
.news-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1.5rem;
}

.news-card {
  border-radius: 1rem;
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  transition: all 0.3s ease;
}
.news-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 40px rgba(0,0,0,0.08);
}

.news-card__image {
  height: 180px;
  /* 抽象渐变缩略图 */
  background: linear-gradient(135deg, #818CF8, #6366F1, #4F46E5);
}

.news-card__body {
  padding: 1.25rem;
}
.news-card__date {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  margin-bottom: 0.5rem;
}
.news-card__title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.4;
}
```

---

## 4. 核心视觉效果总结

| 效果 | 实现方式 | 应用区域 |
|------|---------|---------|
| Glassmorphism 毛玻璃 | `backdrop-filter: blur(12px)` + 半透明背景 | 导航栏、下拉菜单 |
| Aurora 光晕边框 | `radial-gradient` 固定定位伪元素 | 页面四周 |
| 卡片悬停提升 | `transition-all 0.5s` + hover shadow/border | 能力卡片、新闻卡片 |
| 文字循环动画 | JS setInterval + opacity/transform 过渡 | Hero 标题动词 |
| 网格背景 | 线性渐变网格纹理 | 统计数据区块 |
| 渐变抽象图 | `linear-gradient` 多色混合 | 新闻缩略图 |

---

## 5. 响应式策略

```css
@media (max-width: 768px) {
  .capabilities__grid { grid-template-columns: 1fr; }
  .developer__content { grid-template-columns: 1fr; }
  .news-grid { grid-template-columns: repeat(2, 1fr); }
  .header__nav { display: none; } /* 切换为汉堡菜单 */
  .hero__title { font-size: 2rem; }
}
```

---

## 6. TAgent 可借鉴要点

1. **Glassmorphism 导航栏** — 适合 TAgent 顶部工具栏
2. **能力卡片 Grid** — 可用于展示 Agent 能力/工具
3. **Split Button** — 适合多选操作(如"运行/部署"选项)
4. **Aurora 光晕** — 可用于 Agent 状态活跃时的视觉反馈
5. **代码编辑器窗口** — 适合展示 Agent 执行代码/输出
