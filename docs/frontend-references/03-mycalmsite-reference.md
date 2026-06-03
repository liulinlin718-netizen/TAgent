# MyCalmSite 前端参考文档

> **网站地址**: https://mycalmsite.com/  
> **分析日期**: 2026-06-03  
> **设计风格**: 沉浸式冥想体验、玻璃态、呼吸动画、双主题

---

## 1. 整体布局结构

```
┌──────────────────────────────────────────────────┐
│ Header: [● calm site]              [🌙 主题切换] │
├────────┬───────────────────────┬─────────────────┤
│ 左侧栏  │     中央交互区域       │   右侧栏       │
│        │                      │                 │
│ 模式信息 │  "PRESS BEGIN..."    │  AMBIENT 0      │
│ 标题    │                      │  MUTE ALL       │
│ 副标题  │   ┌─────────────┐    │  ───────────    │
│ 描述    │   │  呼吸球/人体  │    │  🌊 Air        │
│        │   │   动画区域    │    │  🔔 Bells       │
│ CYCLE  │   │             │    │  🥣 Bowls       │
│ 1. 吸气 │   └─────────────┘    │  🎵 Calm Flute  │
│ 2. 屏息 │                      │  🔥 Fire        │
│ 3. 呼气 │      [5:00]          │  🌲 Forest      │
│ 4. 屏息 │  1min 3min 5min 10min│  🎸 Guitar      │
│        │                      │  ☯ Meditation   │
│        │   [▶ Begin]  [↻]     │  🌧 Rain        │
│        │                      │  🚀 Space       │
├────────┴───────────────────────┴─────────────────┤
│      [Square]  [Long Exhale]  [Body Scan]        │
└──────────────────────────────────────────────────┘
```

### 关键特征
- 单页全屏沉浸式应用，无滚动条
- 三栏布局：信息面板 | 核心交互 | 环境声控制
- 支持亮色/暗色双主题，平滑过渡
- 底部胶囊标签栏切换三种模式

---

## 2. 设计令牌 (Design Tokens)

```css
:root {
  /* 亮色主题 */
  --bg-light: linear-gradient(135deg, #E8E0F0, #D4E4F7, #F0E4EC);
  --text-light-primary: #2D2B3D;
  --text-light-secondary: #6B6880;
  --text-light-accent: #7C6BC4;
  --panel-light: rgba(255, 255, 255, 0.6);
  --border-glow-light: rgba(147, 130, 220, 0.3);

  /* 暗色主题 */
  --bg-dark: linear-gradient(135deg, #0D0B1A, #1A1040, #0F0D20);
  --text-dark-primary: #E8E4F0;
  --text-dark-secondary: #9B96B0;
  --text-dark-accent: #A78BFA;
  --panel-dark: rgba(30, 25, 60, 0.6);
  --border-glow-dark: rgba(139, 92, 246, 0.4);

  /* 通用 */
  --font-sans: 'Outfit', 'Inter', sans-serif;
  --radius-pill: 9999px;
  --radius-panel: 20px;
  --transition-theme: all 0.6s ease;

  /* 呼吸球颜色 */
  --orb-core: radial-gradient(circle, rgba(167,139,250,0.8), rgba(124,107,196,0.3));
  --orb-ring: rgba(167, 139, 250, 0.15);
}
```

---

## 3. 核心组件代码参考

### 3.1 页面容器 (全屏沉浸 + 发光边框)

```html
<div class="calm-app" data-theme="light">
  <div class="calm-app__glow-border"></div>
  <div class="calm-app__inner">
    <!-- Header, 三栏, Footer -->
  </div>
</div>
```

```css
.calm-app {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-light);
  transition: var(--transition-theme);
  overflow: hidden;
}
.calm-app[data-theme="dark"] { background: var(--bg-dark); }

/* 发光边框 */
.calm-app__glow-border {
  position: absolute;
  inset: 8px;
  border-radius: 16px;
  border: 1px solid var(--border-glow-light);
  box-shadow:
    0 0 30px rgba(147,130,220,0.15),
    inset 0 0 30px rgba(147,130,220,0.05);
  pointer-events: none;
  transition: var(--transition-theme);
}
[data-theme="dark"] .calm-app__glow-border {
  border-color: var(--border-glow-dark);
  box-shadow:
    0 0 40px rgba(139,92,246,0.2),
    inset 0 0 40px rgba(139,92,246,0.08);
}

.calm-app__inner {
  position: relative;
  width: calc(100% - 16px);
  height: calc(100% - 16px);
  display: grid;
  grid-template-rows: auto 1fr auto;
}
```

### 3.2 顶部 Header (品牌 + 主题切换)

```html
<header class="calm-header">
  <div class="calm-header__brand">
    <span class="brand-dot"></span>
    <span class="brand-text">calm site</span>
  </div>
  <button class="theme-toggle" id="themeToggle" aria-label="Toggle theme">
    <svg class="icon-moon" width="20" height="20" viewBox="0 0 24 24">
      <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" fill="currentColor"/>
    </svg>
    <svg class="icon-sun" width="20" height="20" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="5" fill="currentColor"/>
      <g stroke="currentColor" stroke-width="2">
        <line x1="12" y1="1" x2="12" y2="3"/>
        <line x1="12" y1="21" x2="12" y2="23"/>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
        <line x1="1" y1="12" x2="3" y2="12"/>
        <line x1="21" y1="12" x2="23" y2="12"/>
      </g>
    </svg>
  </button>
</header>
```

```css
.calm-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1.25rem 2rem;
}
.calm-header__brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
}
.brand-dot {
  width: 10px; height: 10px;
  background: var(--text-light-accent);
  border-radius: 50%;
}
.brand-text {
  font-family: var(--font-sans);
  font-weight: 600;
  font-size: 1rem;
  color: var(--text-light-primary);
}
.theme-toggle {
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: transparent;
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 50%;
  color: var(--text-light-secondary);
  cursor: pointer;
  transition: var(--transition-theme);
}
.icon-sun { display: none; }
[data-theme="dark"] .icon-moon { display: none; }
[data-theme="dark"] .icon-sun { display: block; }
```

### 3.3 呼吸球动画 (核心交互)

```html
<div class="breathing-orb" id="breathingOrb">
  <div class="orb-ring orb-ring--outer"></div>
  <div class="orb-ring orb-ring--middle"></div>
  <div class="orb-ring orb-ring--inner"></div>
  <div class="orb-core"></div>
  <div class="orb-glow"></div>
</div>
```

```css
.breathing-orb {
  position: relative;
  width: 280px;
  height: 280px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.orb-core {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  background: var(--orb-core);
  box-shadow: 0 0 60px rgba(167,139,250,0.3);
  transition: transform 5s ease-in-out;
}

.orb-ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid var(--orb-ring);
}
.orb-ring--outer { width: 280px; height: 280px; }
.orb-ring--middle { width: 220px; height: 220px; }
.orb-ring--inner { width: 160px; height: 160px; }

.orb-glow {
  position: absolute;
  width: 200px;
  height: 200px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(167,139,250,0.15), transparent 70%);
  filter: blur(30px);
  pointer-events: none;
}

/* 吸气：扩大 */
.breathing-orb.inhale .orb-core {
  transform: scale(1.6);
  box-shadow: 0 0 100px rgba(167,139,250,0.5);
}
/* 呼气：缩小 */
.breathing-orb.exhale .orb-core {
  transform: scale(0.8);
  box-shadow: 0 0 30px rgba(167,139,250,0.2);
}
/* 屏息 */
.breathing-orb.hold .orb-core {
  transform: scale(1.3);
}
```

```javascript
// 呼吸循环控制器
class BreathingController {
  constructor(orbEl, phases) {
    this.orb = orbEl;
    this.phases = phases; // [{name:'inhale',duration:5},{name:'hold',duration:5},...]
    this.currentPhase = 0;
    this.running = false;
  }

  start() {
    this.running = true;
    this.runPhase();
  }

  runPhase() {
    if (!this.running) return;
    const phase = this.phases[this.currentPhase];
    this.orb.className = 'breathing-orb ' + phase.name;
    // 更新UI提示文字
    document.getElementById('phaseLabel').textContent =
      phase.name === 'inhale' ? 'Inhale' :
      phase.name === 'exhale' ? 'Exhale' : 'Hold';

    setTimeout(() => {
      this.currentPhase = (this.currentPhase + 1) % this.phases.length;
      this.runPhase();
    }, phase.duration * 1000);
  }

  stop() { this.running = false; }
}

// 方形呼吸: 5-5-5-5
const square = [
  { name: 'inhale', duration: 5 },
  { name: 'hold', duration: 5 },
  { name: 'exhale', duration: 5 },
  { name: 'hold', duration: 5 },
];
const controller = new BreathingController(
  document.getElementById('breathingOrb'), square
);
```

### 3.4 环境声面板 (右侧栏)

```html
<aside class="ambient-panel">
  <div class="ambient-panel__header">
    <span>🎵 AMBIENT <span id="activeCount">0</span></span>
    <button class="mute-btn" id="muteAll">MUTE ALL</button>
  </div>
  <div class="ambient-panel__list">
    <div class="ambient-item" data-sound="air">
      <span class="ambient-item__icon">🌊</span>
      <span class="ambient-item__name">Air</span>
      <input type="range" class="ambient-slider" min="0" max="100" value="0" />
    </div>
    <div class="ambient-item" data-sound="bells">
      <span class="ambient-item__icon">🔔</span>
      <span class="ambient-item__name">Bells</span>
      <input type="range" class="ambient-slider" min="0" max="100" value="0" />
    </div>
    <!-- 更多音效... -->
  </div>
</aside>
```

```css
.ambient-panel {
  width: 220px;
  padding: 1.25rem;
  background: var(--panel-light);
  backdrop-filter: blur(20px);
  border-radius: var(--radius-panel);
  border: 1px solid rgba(255,255,255,0.4);
  max-height: 400px;
  overflow-y: auto;
}
[data-theme="dark"] .ambient-panel {
  background: var(--panel-dark);
  border-color: rgba(255,255,255,0.08);
}

.ambient-panel__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-light-secondary);
  margin-bottom: 1rem;
}

.mute-btn {
  background: none;
  border: none;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--text-light-secondary);
  cursor: pointer;
  transition: color 0.2s;
}
.mute-btn:hover { color: var(--text-light-primary); }

.ambient-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0;
  cursor: pointer;
  transition: opacity 0.2s;
}
.ambient-item:hover { opacity: 0.8; }

.ambient-item__icon { font-size: 1.125rem; }
.ambient-item__name {
  font-size: 0.875rem;
  color: var(--text-light-primary);
}

/* 极简音量滑块 */
.ambient-slider {
  -webkit-appearance: none;
  width: 60px;
  height: 3px;
  background: rgba(0,0,0,0.1);
  border-radius: 2px;
  outline: none;
  margin-left: auto;
}
.ambient-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--text-light-accent);
  cursor: pointer;
}
```

### 3.5 底部模式切换标签栏

```html
<nav class="mode-tabs">
  <button class="mode-tab active" data-mode="square">Square</button>
  <button class="mode-tab" data-mode="longexhale">Long Exhale</button>
  <button class="mode-tab" data-mode="bodyscan">Body Scan</button>
</nav>
```

```css
.mode-tabs {
  display: flex;
  justify-content: center;
  gap: 0.25rem;
  padding: 1.5rem;
}

.mode-tab {
  padding: 0.625rem 1.5rem;
  font-family: var(--font-sans);
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--text-light-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: all 0.3s ease;
}

.mode-tab.active {
  color: #fff;
  background: var(--text-light-primary);
}
[data-theme="dark"] .mode-tab.active {
  background: rgba(255,255,255,0.15);
  color: var(--text-dark-primary);
}

.mode-tab:not(.active):hover {
  background: rgba(0,0,0,0.05);
}
```

### 3.6 主操作按钮 (Begin/Pause/Resume)

```css
.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.625rem;
  min-width: 240px;
  padding: 1rem 2.5rem;
  font-family: var(--font-sans);
  font-size: 1.125rem;
  font-weight: 600;
  color: #fff;
  background: var(--text-light-primary);
  border: none;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: transform 0.2s, box-shadow 0.2s;
}
.action-btn:hover {
  transform: scale(1.02);
  box-shadow: 0 8px 30px rgba(0,0,0,0.15);
}
.action-btn:active { transform: scale(0.98); }

/* 重置按钮 */
.reset-btn {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--text-light-primary);
  color: #fff;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.3s;
}
.reset-btn:hover { transform: rotate(-90deg); }
```

### 3.7 时长选择器

```css
.duration-selector {
  display: flex;
  gap: 0.25rem;
  justify-content: center;
}

.duration-opt {
  padding: 0.375rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--text-light-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: all 0.2s;
}
.duration-opt.active {
  background: rgba(0,0,0,0.05);
  border-color: rgba(0,0,0,0.1);
  color: var(--text-light-primary);
}
```

---

## 4. 核心视觉效果总结

| 效果 | 实现方式 | 应用区域 |
|------|---------|---------|
| 呼吸球脉动 | CSS transform scale + JS 定时器 | 中央交互 |
| 玻璃态面板 | `backdrop-filter: blur(20px)` + 半透明 bg | 侧栏面板 |
| 发光边框 | `box-shadow` 多层光晕 | 页面外框 |
| 浮动粒子/星尘 | 绝对定位小圆点 + CSS 动画 | 暗色背景 |
| 主题平滑切换 | CSS 变量 + `transition: all 0.6s` | 全局 |
| 重置按钮旋转 | `hover: rotate(-90deg)` | 重置按钮 |
| 渐变背景 | 多色 linear-gradient | 全屏背景 |

---

## 5. TAgent 可借鉴要点

1. **沉浸式全屏体验** — Agent 执行任务时可进入全屏专注模式
2. **呼吸球 → 心跳脉动** — 可直接转化为 Agent 活跃状态的 Pulse Flow 动画
3. **环境声面板** — 可改为"Agent 通道"面板，控制不同 Agent 的活跃度
4. **双主题系统** — CSS 变量驱动的亮/暗主题，适合 TAgent 全局使用
5. **模式切换标签栏** — 适合切换不同 Agent 视图模式
6. **玻璃态面板** — 适合浮动的治理事件/日志面板
