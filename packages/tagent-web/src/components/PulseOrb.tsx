/**
 * PulseOrb — Agent 脉动光球组件
 *
 * 灵感来源: mycalmsite 呼吸球 (breathing orb)
 * 3 层同心环 + 渐变核心 + 外围光晕
 * 4 种状态: idle / busy / waiting / error
 */

'use client';

import React from 'react';
import styles from './PulseOrb.module.css';

export type OrbStatus = 'idle' | 'busy' | 'waiting' | 'error';
export type OrbSize = 'sm' | 'md' | 'lg';

interface PulseOrbProps {
  status?: OrbStatus;
  size?: OrbSize;
  className?: string;
  label?: string;
}

export function PulseOrb({
  status = 'idle',
  size = 'md',
  className = '',
  label,
}: PulseOrbProps) {
  return (
    <div
      className={`${styles.orb} ${styles[status]} ${styles[size]} ${className}`}
      role="status"
      aria-label={label || `Agent status: ${status}`}
    >
      <div className={styles.ring3} />
      <div className={styles.ring2} />
      <div className={styles.ring1} />
      <div className={styles.core} />
      <div className={styles.glow} />
    </div>
  );
}
