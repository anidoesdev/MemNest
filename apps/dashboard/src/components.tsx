import type { MemoryKind } from '@memnest/core';
import { useState } from 'react';
import { KIND_LABEL } from './format';
import { applyThemeChoice, readThemeChoice, type ThemeChoice } from './themeChoice';

/** A kind is always its colour and its name: never colour alone. */
export function KindBadge({ kind }: { kind: MemoryKind }) {
  return (
    <span className={`kind-badge kind-${kind}`}>
      <span className="kind-dot" aria-hidden="true" />
      {KIND_LABEL[kind]}
    </span>
  );
}

/** Labelled for screen readers unless `decorative`: use that when the kind's name is already written beside it. */
export function KindDot({ kind, decorative = false }: { kind: MemoryKind; decorative?: boolean }) {
  return decorative ? (
    <span className={`kind-dot kind-${kind}`} aria-hidden="true" />
  ) : (
    <span className={`kind-dot kind-${kind}`} role="img" aria-label={KIND_LABEL[kind]} />
  );
}

export function StatusTags({ status }: { status: string[] }) {
  if (status.length === 0) return null;
  return (
    <>
      {status.map((s) => (
        <span key={s} className={`tag tag-${s.toLowerCase()}`}>
          {s}
        </span>
      ))}
    </>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <Mark size={40} />
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="error" role="alert">
      {message}
    </p>
  );
}

/** The Memnest mark: three memories, one of each kind, joined into a small network. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 21 L16 9 L23 21 Z" className="mark-links" />
      <circle cx="16" cy="9" r="4.5" className="mark-node kind-fill kind-episode" />
      <circle cx="9" cy="21" r="4.5" className="mark-node kind-fill kind-fact" />
      <circle cx="23" cy="21" r="4.5" className="mark-node kind-fill kind-preference" />
    </svg>
  );
}

/** The wordmark with its mark. */
export function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className={`brand ${large ? 'large' : ''}`}>
      <Mark size={large ? 30 : 22} />
      <span className={`wordmark ${large ? '' : 'small'}`}>Memnest</span>
    </span>
  );
}

const THEME_LABEL: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };

/** Cycles the page theme: system → light → dark. */
export function ThemeToggle() {
  const [choice, setChoice] = useState(readThemeChoice);
  const next = NEXT_THEME[choice];
  return (
    <button
      type="button"
      className="button ghost small theme-toggle"
      onClick={() => {
        applyThemeChoice(next);
        setChoice(next);
      }}
      aria-label={`Theme: ${THEME_LABEL[choice]}. Switch to ${THEME_LABEL[next]}.`}
      title={`Theme: ${THEME_LABEL[choice]}`}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" className="icon">
        {choice === 'light' && (
          <>
            <circle cx="12" cy="12" r="4.5" />
            <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
          </>
        )}
        {choice === 'dark' && <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />}
        {choice === 'system' && (
          <>
            <rect x="3" y="4.5" width="18" height="12" rx="2" />
            <path d="M9 20h6M12 16.5V20" />
          </>
        )}
      </svg>
      {THEME_LABEL[choice]}
    </button>
  );
}
