import { useEffect, useRef, useState, type ReactNode } from 'react';

const ICONS = {
  play: <path d="M7 4.5v15l12-7.5-12-7.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  loop: <path d="M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4" />,
  rewind: <path d="M4 5v14M20 5l-11 7 11 7V5z" />,
  target: (
    <>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  reload: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  ear: <path d="M6 9a6 6 0 1 1 12 0c0 3-2 4-3 5.5S14 18 12 20a3 3 0 0 1-4-1M10 9a2 2 0 1 1 4 0" />,
  save: <path d="M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  notes: <path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5" />,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label}>
      {ICONS[name]}
    </svg>
  );
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <h2 className="card-title">
          <span>{title}</span>
          {actions}
        </h2>
      )}
      {children}
    </section>
  );
}

export type BannerTone = 'error' | 'info' | 'success' | 'warn';

export function Banner({ tone, children, action, onDismiss }: { tone: BannerTone; children: ReactNode; action?: ReactNode; onDismiss?: () => void }) {
  return (
    <div className={`banner ${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <div className="grow">{children}</div>
      {action}
      {onDismiss && (
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={onDismiss} aria-label="Dismiss">
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Destructive button that asks for a second click within 3 s instead of a modal dialog. */
export function ConfirmButton({ onConfirm, label, confirmLabel = 'Confirm', small, icon = 'trash', disabled }: { onConfirm: () => void; label: string; confirmLabel?: string; small?: boolean; icon?: IconName; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      disabled={disabled}
      className={`btn btn-danger ${small ? 'btn-sm' : ''} ${armed ? 'confirm' : 'btn-ghost'} ${!armed ? 'btn-icon' : ''}`}
      aria-label={armed ? confirmLabel : label}
      title={armed ? undefined : label}
      onClick={() => {
        if (armed) {
          clearTimeout(timer.current);
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          timer.current = setTimeout(() => setArmed(false), 3000);
        }
      }}
    >
      {armed ? confirmLabel : <Icon name={icon} />}
    </button>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
