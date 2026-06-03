/**
 * TAgent Design System — Radix UI 组件库 (V2.0)
 *
 * 基于 Radix UI 原语 + CSS Modules 样式化 (plan §5.1)
 *
 * 组件列表:
 *   1. Button      — 主/次/危险/幽灵 4 种变体 + Radix Slot (asChild)
 *   2. Input       — 带标签和错误状态
 *   3. Card        — 通用容器，支持 hover 效果
 *   4. Badge       — 标签/状态指示器
 *   5. Modal       — Radix Dialog (Portal + Overlay + Content + Close)
 *   6. Tooltip     — Radix Tooltip (延迟显示 + 箭头)
 *   7. DropdownMenu — Radix DropdownMenu (键盘导航 + 动画)
 */

'use client';

import {
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  forwardRef,
} from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Slot } from '@radix-ui/react-slot';
import styles from './ui.module.css';

// ─── 1. Button (+ Radix Slot asChild) ───────────────

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  /** Radix asChild: 将样式传递给子元素而非渲染 <button> */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    icon,
    asChild = false,
    children,
    className,
    disabled,
    ...props
  },
  ref,
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={`${styles.btn} ${styles[`btn_${variant}`]} ${styles[`btn_${size}`]} ${className || ''}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <span className={styles.btnSpinner} />}
      {!loading && icon && <span className={styles.btnIcon}>{icon}</span>}
      {children}
    </Comp>
  );
});

// ─── 2. Input ────────────────────────────────────────

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export function Input({ label, error, hint, className, id, ...props }: InputProps) {
  const inputId = id || `input-${label?.replace(/\s/g, '-') || 'default'}`;
  return (
    <div className={`${styles.inputWrapper} ${className || ''}`}>
      {label && <label htmlFor={inputId} className={styles.inputLabel}>{label}</label>}
      <input
        id={inputId}
        className={`${styles.input} ${error ? styles.inputError : ''}`}
        {...props}
      />
      {error && <span className={styles.inputErrorMsg}>{error}</span>}
      {!error && hint && <span className={styles.inputHint}>{hint}</span>}
    </div>
  );
}

// ─── 3. Card ─────────────────────────────────────────

interface CardProps {
  children: ReactNode;
  className?: string;
  hoverable?: boolean;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  onClick?: () => void;
}

export function Card({ children, className, hoverable = false, padding = 'md', onClick }: CardProps) {
  return (
    <div
      className={`${styles.card} ${styles[`card_pad_${padding}`]} ${hoverable ? styles.cardHoverable : ''} ${className || ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {children}
    </div>
  );
}

// ─── 4. Badge ────────────────────────────────────────

export type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  dot?: boolean;
  className?: string;
}

export function Badge({ children, variant = 'default', dot = false, className }: BadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[`badge_${variant}`]} ${className || ''}`}>
      {dot && <span className={styles.badgeDot} />}
      {children}
    </span>
  );
}

// ─── 5. Modal (Radix Dialog) ─────────────────────────

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}

export function Modal({ open, onClose, title, children, footer, width }: ModalProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.modalOverlay} />
        <DialogPrimitive.Content
          className={styles.modalContent}
          style={width ? { maxWidth: width } : undefined}
          aria-describedby={undefined}
        >
          {title && (
            <div className={styles.modalHeader}>
              <DialogPrimitive.Title className={styles.modalTitle}>
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Close className={styles.modalClose} aria-label="Close">
                ✕
              </DialogPrimitive.Close>
            </div>
          )}
          <div className={styles.modalBody}>{children}</div>
          {footer && <div className={styles.modalFooter}>{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// ─── 6. Tooltip (Radix Tooltip) ──────────────────────

interface TooltipProps {
  children: ReactNode;
  content: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  delayDuration?: number;
}

export function Tooltip({ children, content, side = 'top', delayDuration = 300 }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            className={styles.tooltipContent}
            side={side}
            sideOffset={5}
          >
            {content}
            <TooltipPrimitive.Arrow className={styles.tooltipArrow} />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

// ─── 7. DropdownMenu (Radix DropdownMenu) ────────────

interface DropdownMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

interface DropdownMenuProps {
  trigger: ReactNode;
  items: DropdownMenuItem[];
  align?: 'start' | 'center' | 'end';
}

export function DropdownMenu({ trigger, items, align = 'end' }: DropdownMenuProps) {
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        {trigger}
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          className={styles.dropdownContent}
          align={align}
          sideOffset={5}
        >
          {items.map((item, i) => (
            <DropdownMenuPrimitive.Item
              key={i}
              className={`${styles.dropdownItem} ${item.danger ? styles.dropdownItemDanger : ''}`}
              onClick={item.onClick}
              disabled={item.disabled}
            >
              {item.icon && <span className={styles.dropdownItemIcon}>{item.icon}</span>}
              {item.label}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}
