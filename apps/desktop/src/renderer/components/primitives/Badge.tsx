import React from 'react';
import { STATUS, STATUS_SOFT, type StatusTone } from '../../tokens.js';

/** A colored state dot, optionally pulsing while the thing is live. */
export function StatusDot({
  tone = 'neutral', color, pulse = false, size = 8, className = '', title,
}: {
  tone?: StatusTone;
  /** Explicit token color, when the caller already resolved one. */
  color?: string;
  pulse?: boolean;
  size?: number;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${pulse ? 'animate-pulse' : ''} ${className}`}
      style={{ background: color ?? STATUS[tone], width: size, height: size }}
      title={title}
      aria-hidden
    />
  );
}

/** A small state pill: solid (filled with the state color) or soft (tinted). */
export function Badge({
  tone = 'neutral', color, variant = 'soft', children, className = '', title,
}: {
  tone?: StatusTone;
  color?: string;
  variant?: 'soft' | 'solid' | 'plain';
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const base = color ?? STATUS[tone];
  const style: React.CSSProperties =
    variant === 'solid'
      ? { background: base, color: '#fff' }
      : variant === 'soft'
        ? { background: color ? `color-mix(in srgb, ${color} 16%, transparent)` : STATUS_SOFT[tone as keyof typeof STATUS_SOFT] ?? STATUS_SOFT.neutral, color: base }
        : { color: base };
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${className}`}
      style={style}
      title={title}
    >
      {children}
    </span>
  );
}
