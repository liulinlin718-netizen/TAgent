/**
 * Framer Motion — 延迟加载优化 (Lighthouse Performance)
 *
 * 使用 framer-motion 的 LazyMotion + domAnimation 特性包,
 * 只加载必要的动画功能（~16KB vs 完整 ~36KB）。
 */

'use client';

export { LazyMotion, domAnimation, m, AnimatePresence } from 'framer-motion';
