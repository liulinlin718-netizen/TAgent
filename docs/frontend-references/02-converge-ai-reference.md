# Converge.AI 前端参考文档

> **网站地址**: https://converge.ai/  
> **分析日期**: 2026-06-03  
> **设计风格**: 超极简主义、黑白高对比、点阵图案、宇宙蓝光晕

---

## 1. 整体布局结构

```
┌─────────────────────────────────────────────────┐
│  Sticky Header (Logo + Nav + CTAs)              │
│  backdrop-blur 毛玻璃效果                        │
├─────────────────────────────────────────────────┤
│  Hero Section                                   │
│  "Individual Intelligence ←→                    │
│   Institutional Intelligence"                   │
│  + 搜索/聊天输入框 + 浮动模糊暗色形状             │
├─────────────────────────────────────────────────┤
│  "What We Bring to the World" (双栏)            │
│  ┌──────────┬──────────────────────┐            │
│  │ 大标题    │  2x2 Feature Grid   │            │
│  │          │  ┌────┐ ┌────┐      │            │
│  │          │  │ F1 │ │ F2 │      │            │
│  │          │  ├────┤ ├────┤      │            │
│  │          │  │ F3 │ │ F4 │      │            │
│  │          │  └────┘ └────┘      │            │
│  └──────────┴──────────────────────┘            │
├─────────────────────────────────────────────────┤
│  Dark Banner ("Labor of Love")                  │
│  蓝色行星光晕 + 滚动提示                         │
├─────────────────────────────────────────────────┤
│  Enter Pro 展示区                                │
│  标题 + 描述 + CTA + 水平滑动 Carousel           │
├─────────────────────────────────────────────────┤
│  Framia Pro 展示区                               │
│  标题 + 描述 + CTA + 3列 Feature Grid            │
├─────────────────────────────────────────────────┤
│  Stats Section (200K+ | 110+ | 50×)             │
│  细竖线分隔                                      │
├─────────────────────────────────────────────────┤
│  Testimonials Carousel                          │
├─────────────────────────────────────────────────┤
│  Get Started CTA (圆角黑色容器 + 搜索栏)         │
├─────────────────────────────────────────────────┤
│  Footer (Logo + 3列链接 + 社交图标)              │
└─────────────────────────────────────────────────┘
```

---

## 2. 设计令牌 (Design Tokens)

### 颜色系统

```css
:root {
  /* 背景色 */
  --bg-main: #F6F6F6;           /* 温暖浅灰 */
  --bg-dark: #000000;           /* 深色区块 */
  --bg-dark-alt: #0B0B0B;       /* 略浅深色 */
  --bg-card: #FFFFFF;

  /* 文字色 */
  --text-primary: #000000;
  --text-muted: #767676;        /* 导航/描述文字 */
  --text-on-dark: #FFFFFC;      /* 深色背景上的文字 */

  /* 强调色 */
  --accent-blue-glow: radial-gradient(ellipse, rgba(59,130,246,0.3), transparent);
  --accent-border: rgba(0,0,0,0.1);

  /* 边框 */
  --border-light: rgba(0,0,0,0.1);
  --border-dark: rgba(255,255,255,0.1);
}
```

### 字体系统

```css
@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap');

:root {
  --font-primary: 'Instrument Sans', -apple-system, BlinkMacSystemFont, sans-serif;

  /* 字号层级 */
  --text-hero: clamp(3rem, 6vw, 5rem);
  --text-section: clamp(2rem, 4vw, 3rem);
  --text-body: 1rem;
  --text-sm: 0.875rem;
  --text-xs: 0.75rem;

  /* 字间距 */
  --tracking-tight: -0.48px;
  --tracking-tighter: -0.03em;
}
```

---

## 3. 核心组件代码参考

### 3.1 导航栏 (Glassmorphism Sticky Header)

```html
<header class="cv-header">
  <div class="cv-header__left">
    <a href="/" class="cv-logo">
      <div class="cv-logo__icon">
        <span class="dot dot--center"></span>
        <span class="dot dot--tl"></span>
        <span class="dot dot--tr"></span>
        <span class="dot dot--bl"></span>
        <span class="dot dot--br"></span>
      </div>
      <span class="cv-logo__text">Converge AI</span>
    </a>
  </div>
  <nav class="cv-header__nav">
    <a href="#" class="cv-nav-link">Product</a>
    <a href="/pricing" class="cv-nav-link">Pricing</a>
    <a href="#" class="cv-nav-link">Company</a>
  </nav>
  <div class="cv-header__actions">
    <a href="#" class="cv-btn cv-btn--text">Log in</a>
    <a href="#" class="cv-btn cv-btn--pill">Try Our Products</a>
  </div>
</header>
```

```css
.cv-header {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 2rem;
  background: rgba(246, 246, 246, 0.85);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  transition: box-shadow 0.3s ease;
}
.cv-header.scrolled {
  box-shadow: 0 1px 20px rgba(0, 0, 0, 0.06);
}

/* Logo 点阵图标 */
.cv-logo {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
}
.cv-logo__icon {
  position: relative;
  width: 24px;
  height: 24px;
}
.cv-logo__icon .dot {
  position: absolute;
  width: 5px;
  height: 5px;
  background: var(--text-primary);
  border-radius: 50%;
}
.dot--center { top: 50%; left: 50%; transform: translate(-50%, -50%); }
.dot--tl { top: 0; left: 0; }
.dot--tr { top: 0; right: 0; }
.dot--bl { bottom: 0; left: 0; }
.dot--br { bottom: 0; right: 0; }

.cv-logo__text {
  font-family: var(--font-primary);
  font-weight: 600;
  font-size: 1.125rem;
  color: var(--text-primary);
}

/* 导航链接 */
.cv-nav-link {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.2s ease;
}
.cv-nav-link:hover { color: var(--text-primary); }

/* 胶囊按钮 */
.cv-btn--pill {
  display: inline-flex;
  align-items: center;
  padding: 0.625rem 1.5rem;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-on-dark);
  background: var(--text-primary);
  border: none;
  border-radius: 62px;
  text-decoration: none;
  transition: opacity 0.2s;
}
.cv-btn--pill:hover { opacity: 0.85; }

.cv-btn--text {
  font-size: var(--text-sm);
  color: var(--text-primary);
  text-decoration: none;
  transition: opacity 0.2s;
}
.cv-btn--text:hover { opacity: 0.6; }
```

### 3.2 Hero Section (交互式搜索框)

```html
<section class="cv-hero">
  <!-- 浮动暗色形状 (装饰) -->
  <div class="cv-hero__blobs">
    <div class="blob blob--1"></div>
    <div class="blob blob--2"></div>
    <div class="blob blob--3"></div>
  </div>

  <div class="cv-hero__content">
    <h1 class="cv-hero__title">
      <span class="cv-hero__line">Individual Intelligence</span>
      <span class="cv-hero__icon"><!-- Converge dot icon --></span>
      <span class="cv-hero__line">Institutional Intelligence</span>
    </h1>
    <p class="cv-hero__subtitle">
      Where teams, context, and agents converge to power real businesses.
    </p>

    <!-- 搜索/聊天输入框 -->
    <div class="cv-hero__input-container">
      <input
        type="text"
        class="cv-hero__input"
        placeholder="Ask anything, or describe a task..."
      />
      <button class="cv-hero__submit" aria-label="Submit">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 12h14m-7-7l7 7-7 7"/>
        </svg>
      </button>
    </div>
  </div>
</section>
```

```css
.cv-hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 90vh;
  padding: 4rem 2rem;
  overflow: hidden;
}

/* 浮动暗色装饰形状 */
.cv-hero__blobs { position: absolute; inset: 0; pointer-events: none; }
.blob {
  position: absolute;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.08);
  filter: blur(60px);
  animation: blobFloat 20s ease-in-out infinite;
}
.blob--1 { width: 300px; height: 300px; top: 20%; left: 10%; }
.blob--2 { width: 200px; height: 200px; top: 40%; right: 15%; animation-delay: -7s; }
.blob--3 { width: 250px; height: 250px; bottom: 10%; left: 40%; animation-delay: -14s; }

@keyframes blobFloat {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(30px, -20px) scale(1.05); }
  66% { transform: translate(-20px, 15px) scale(0.95); }
}

.cv-hero__content {
  position: relative;
  z-index: 10;
  text-align: center;
  max-width: 48rem;
}

.cv-hero__title {
  font-family: var(--font-primary);
  font-size: var(--text-hero);
  font-weight: 400;
  letter-spacing: var(--tracking-tight);
  line-height: 1.05;
  color: var(--text-primary);
  margin-bottom: 1.5rem;
}

.cv-hero__subtitle {
  font-size: 1.125rem;
  color: var(--text-muted);
  line-height: 1.6;
  margin-bottom: 3rem;
}

/* 搜索输入框 */
.cv-hero__input-container {
  position: relative;
  width: 100%;
  max-width: 36rem;
  margin: 0 auto;
}

.cv-hero__input {
  width: 100%;
  padding: 1.25rem 3.5rem 1.25rem 1.5rem;
  font-family: var(--font-primary);
  font-size: 1rem;
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid var(--border-light);
  border-radius: 24px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.cv-hero__input:focus {
  border-color: rgba(0,0,0,0.2);
  box-shadow: 0 4px 20px rgba(0,0,0,0.06);
}
.cv-hero__input::placeholder { color: var(--text-muted); }

.cv-hero__submit {
  position: absolute;
  right: 8px;
  bottom: 8px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #040404;
  color: #fff;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.15s, opacity 0.15s;
}
.cv-hero__submit:hover {
  transform: scale(1.05);
  opacity: 0.9;
}
```

### 3.3 Feature Grid (点阵图标 + 双栏)

```html
<section class="cv-features">
  <div class="cv-features__layout">
    <div class="cv-features__header">
      <h2 class="cv-section-title">What We Bring<br>to the World</h2>
    </div>
    <div class="cv-features__grid">
      <div class="cv-feature-item">
        <div class="cv-feature-icon">
          <!-- 点阵图标 (不同排列形态) -->
          <span class="fi-dot"></span><span class="fi-dot"></span>
          <span class="fi-dot"></span><span class="fi-dot"></span>
        </div>
        <h3 class="cv-feature-title">Intelligences work<br>better together.</h3>
        <p class="cv-feature-desc">No longer need to switch between isolated products and subscriptions.</p>
      </div>
      <div class="cv-feature-item">
        <div class="cv-feature-icon"><!-- 点阵变体 --></div>
        <h3 class="cv-feature-title">Built for results,<br>not just outputs.</h3>
        <p class="cv-feature-desc">We empower you to build, create, distribute, analyze, and deliver.</p>
      </div>
      <div class="cv-feature-item">
        <div class="cv-feature-icon"><!-- 点阵变体 --></div>
        <h3 class="cv-feature-title">Operate beyond<br>your team size.</h3>
        <p class="cv-feature-desc">Leverage pro-level AI agents that act as multiple roles.</p>
      </div>
      <div class="cv-feature-item">
        <div class="cv-feature-icon"><!-- 点阵变体 --></div>
        <h3 class="cv-feature-title">Smoothly evolve into<br>AI-native organization.</h3>
        <p class="cv-feature-desc">Move beyond traditional workflows into true AI-native ways of working.</p>
      </div>
    </div>
  </div>
</section>
```

```css
.cv-features {
  padding: 6rem 2rem;
  max-width: 72rem;
  margin: 0 auto;
}

.cv-features__layout {
  display: grid;
  grid-template-columns: 1fr 1.2fr;
  gap: 4rem;
  align-items: start;
}

.cv-section-title {
  font-family: var(--font-primary);
  font-size: var(--text-section);
  font-weight: 400;
  letter-spacing: var(--tracking-tighter);
  color: var(--text-primary);
  line-height: 1.15;
}

.cv-features__grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 3rem;
}

.cv-feature-icon {
  display: grid;
  grid-template-columns: repeat(2, 8px);
  gap: 4px;
  margin-bottom: 1.25rem;
}
.fi-dot {
  width: 8px;
  height: 8px;
  background: var(--text-primary);
  border-radius: 50%;
}

.cv-feature-title {
  font-family: var(--font-primary);
  font-size: 1.25rem;
  font-weight: 500;
  letter-spacing: var(--tracking-tight);
  color: var(--text-primary);
  line-height: 1.3;
  margin-bottom: 0.75rem;
}

.cv-feature-desc {
  font-size: var(--text-sm);
  color: var(--text-muted);
  line-height: 1.6;
}
```

### 3.4 深色宇宙 Banner

```html
<section class="cv-dark-banner">
  <div class="cv-dark-banner__glow"></div>
  <div class="cv-dark-banner__content">
    <h2 class="cv-dark-banner__title">A labor of love for<br>the acceleration of intelligence</h2>
  </div>
  <div class="cv-dark-banner__scroll-hint">
    <div class="scroll-mouse">
      <div class="scroll-wheel"></div>
    </div>
  </div>
</section>
```

```css
.cv-dark-banner {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  background: var(--bg-dark);
  overflow: hidden;
}

/* 行星光晕 */
.cv-dark-banner__glow {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 500px;
  height: 500px;
  background: radial-gradient(
    ellipse at center,
    rgba(59, 130, 246, 0.15) 0%,
    rgba(59, 130, 246, 0.05) 40%,
    transparent 70%
  );
  border-radius: 50%;
  filter: blur(40px);
}

.cv-dark-banner__title {
  position: relative;
  z-index: 10;
  font-family: var(--font-primary);
  font-size: clamp(2rem, 4vw, 3.5rem);
  font-weight: 400;
  color: var(--text-on-dark);
  text-align: center;
  letter-spacing: var(--tracking-tighter);
}

/* 滚动提示动画 */
.scroll-mouse {
  width: 24px;
  height: 38px;
  border: 2px solid rgba(255,255,255,0.3);
  border-radius: 12px;
  position: relative;
}
.scroll-wheel {
  width: 4px;
  height: 8px;
  background: rgba(255,255,255,0.5);
  border-radius: 2px;
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  animation: scrollBounce 2s ease-in-out infinite;
}
@keyframes scrollBounce {
  0%, 100% { opacity: 1; transform: translateX(-50%) translateY(0); }
  50% { opacity: 0.3; transform: translateX(-50%) translateY(12px); }
}
```

### 3.5 统计数据展示 (竖线分隔)

```html
<section class="cv-stats">
  <div class="cv-stats__grid">
    <div class="cv-stat">
      <span class="cv-stat__number">200K+</span>
      <span class="cv-stat__label">Creators</span>
      <p class="cv-stat__desc">Empowering a growing community of builders worldwide.</p>
    </div>
    <div class="cv-stat__divider"></div>
    <div class="cv-stat">
      <span class="cv-stat__number">110+</span>
      <span class="cv-stat__label">Countries & Regions</span>
      <p class="cv-stat__desc">Supporting AI-native work across a global network.</p>
    </div>
    <div class="cv-stat__divider"></div>
    <div class="cv-stat">
      <span class="cv-stat__number">50×</span>
      <span class="cv-stat__label">Faster Execution</span>
      <p class="cv-stat__desc">Accelerating decision-making from weeks to hours.</p>
    </div>
  </div>
</section>
```

```css
.cv-stats {
  padding: 6rem 2rem;
  max-width: 72rem;
  margin: 0 auto;
}

.cv-stats__grid {
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 3rem;
}

.cv-stat {
  flex: 1;
  text-align: center;
}

.cv-stat__number {
  display: block;
  font-family: var(--font-primary);
  font-size: clamp(2.5rem, 5vw, 4rem);
  font-weight: 600;
  letter-spacing: var(--tracking-tighter);
  color: var(--text-primary);
}

.cv-stat__label {
  display: block;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-primary);
  margin: 0.5rem 0;
}

.cv-stat__desc {
  font-size: var(--text-sm);
  color: var(--text-muted);
  line-height: 1.5;
}

.cv-stat__divider {
  width: 1px;
  background: var(--border-light);
  align-self: stretch;
}
```

### 3.6 带方向箭头的CTA链接按钮

```css
/* ↗ 方向箭头 CTA */
.cv-cta-link {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.75rem 1.5rem;
  font-family: var(--font-primary);
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-on-dark);
  background: var(--text-primary);
  border: none;
  border-radius: 62px;
  text-decoration: none;
  transition: opacity 0.2s;
}
.cv-cta-link::after {
  content: '↗';
  font-size: 1rem;
  transition: transform 0.2s;
}
.cv-cta-link:hover::after {
  transform: translate(2px, -2px);
}
.cv-cta-link:hover { opacity: 0.85; }
```

### 3.7 Footer (三列链接 + 社交图标)

```html
<footer class="cv-footer">
  <div class="cv-footer__top">
    <div class="cv-footer__brand">
      <div class="cv-logo"><!-- 点阵 logo --></div>
      <span>Converge AI</span>
    </div>
    <div class="cv-footer__columns">
      <div class="cv-footer__col">
        <h4 class="cv-footer__heading">Product</h4>
        <a href="#" class="cv-footer__link">Enter Pro</a>
        <a href="#" class="cv-footer__link">Framia Pro</a>
        <a href="#" class="cv-footer__link">Converge Agent</a>
      </div>
      <div class="cv-footer__col">
        <h4 class="cv-footer__heading">Company</h4>
        <a href="#" class="cv-footer__link">About Us</a>
        <a href="mailto:contact@converge.ai" class="cv-footer__link">Contact us</a>
      </div>
      <div class="cv-footer__col">
        <h4 class="cv-footer__heading">Terms & Policies</h4>
        <a href="#" class="cv-footer__link">Terms of Service</a>
        <a href="#" class="cv-footer__link">Privacy Policy</a>
      </div>
    </div>
  </div>
  <div class="cv-footer__bottom">
    <span>© 2026 Converge AI. All rights reserved.</span>
    <div class="cv-footer__social">
      <a href="#" aria-label="X (Twitter)">𝕏</a>
      <a href="#" aria-label="LinkedIn">in</a>
    </div>
  </div>
</footer>
```

```css
.cv-footer {
  padding: 4rem 2rem 2rem;
  max-width: 72rem;
  margin: 0 auto;
  border-top: 1px solid var(--border-light);
}

.cv-footer__top {
  display: flex;
  justify-content: space-between;
  margin-bottom: 3rem;
}

.cv-footer__columns {
  display: flex;
  gap: 4rem;
}

.cv-footer__col {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.cv-footer__heading {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
}

.cv-footer__link {
  font-size: var(--text-sm);
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.2s;
}
.cv-footer__link:hover { color: var(--text-primary); }

.cv-footer__bottom {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-top: 2rem;
  border-top: 1px solid var(--border-light);
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.cv-footer__social {
  display: flex;
  gap: 1rem;
}
.cv-footer__social a {
  color: var(--text-muted);
  text-decoration: none;
  transition: color 0.2s;
}
.cv-footer__social a:hover { color: var(--text-primary); }
```

---

## 4. 核心视觉效果总结

| 效果 | 实现方式 | 应用区域 |
|------|---------|---------|
| Glassmorphism 毛玻璃 | `backdrop-filter: blur(16px)` | 导航栏 |
| 行星光晕 | `radial-gradient` + `filter: blur` | 深色 Banner |
| 浮动装饰形状 | 绝对定位圆形 + blur + CSS 动画 | Hero 背景 |
| 点阵图标系统 | CSS Grid 排列圆点 | Logo、Feature 图标 |
| 胶囊按钮 | `border-radius: 62px` | 所有 CTA |
| 竖线分隔 | 1px 宽 div + `align-self: stretch` | 统计区 |
| 方向箭头动效 | `::after` 伪元素 + hover transform | CTA 链接 |

---

## 5. TAgent 可借鉴要点

1. **极简主义美学** — 大量留白 + Instrument Sans 字体 = 高端感
2. **点阵图标系统** — 可为 TAgent Agent 类型设计独特点阵标识
3. **搜索/任务输入框** — 适合 TAgent 的任务输入交互
4. **深色宇宙 Banner** — 可用于 Agent "思考中"或"深度处理"的视觉反馈
5. **统计仪表板布局** — 适合展示 Agent 运行指标
6. **双产品展示模式** — 可用于展示多 Agent 能力差异
