// Form primitives shared across every editor page (biomes,
// enemies, decorators, future ones). Just enough abstraction to
// keep the per-domain pages focused on their schema shape rather
// than on Tailwind class plumbing.
//
// Each primitive takes `value` + `onChange` (controlled) plus a
// `label` and optional `hint`. All inputs are styled to match
// the existing zinc/neutral editor palette.

'use client';

import { useEffect, useState, type ReactNode } from 'react';

export function FormSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 mb-6">
      <h3 className="text-xs uppercase tracking-wider text-zinc-500 border-b border-zinc-800 pb-1">
        {title}
      </h3>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

export function FieldRow({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5 text-xs">
      <span className="text-zinc-300">
        {label}
        {required && <span className="text-amber-400 ml-0.5">*</span>}
      </span>
      {children}
      {hint && <span className="text-[10px] text-zinc-500">{hint}</span>}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  monospace,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  monospace?: boolean;
  disabled?: boolean;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm ${
          monospace ? 'font-mono' : ''
        } ${disabled ? 'opacity-50' : ''}`}
      />
    </FieldRow>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  hint,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(Number.isFinite(v) ? v : 0);
        }}
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
      />
    </FieldRow>
  );
}

export function SliderField({
  label,
  value,
  onChange,
  hint,
  min = 0,
  max = 1,
  step = 0.05,
  decimals,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  // Display precision. Defaults to enough digits to render the
  // step cleanly (step 0.001 → 3, 0.01 → 2, 0.1 → 1). Override
  // when a slider's step is finer than its meaningful display.
  decimals?: number;
}) {
  const dp =
    decimals ??
    (step >= 0.1 ? 1 : step >= 0.01 ? 2 : step >= 0.001 ? 3 : 4);
  return (
    <FieldRow label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="range"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
          className="flex-1"
        />
        <span className="font-mono text-[10px] text-zinc-400 w-12 text-right">
          {value.toFixed(dp)}
        </span>
      </div>
    </FieldRow>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded h-7 w-12 cursor-pointer"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
        />
      </div>
    </FieldRow>
  );
}

export function EnumField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  hint?: string;
}) {
  return (
    <FieldRow label={label} hint={hint}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

export function CheckboxField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-zinc-500"
      />
      <span>{label}</span>
      {hint && <span className="text-[10px] text-zinc-500">— {hint}</span>}
    </label>
  );
}

// Generic add/remove list editor. Each entry has its own row
// rendered by the caller. Manages the array operations + render
// of the [+ add] / [×] controls.
export function ListField<T>({
  label,
  entries,
  onChange,
  newEntry,
  renderRow,
  hint,
}: {
  label: string;
  entries: T[];
  onChange: (next: T[]) => void;
  newEntry: () => T;
  renderRow: (entry: T, index: number, update: (next: T) => void) => ReactNode;
  hint?: string;
}) {
  return (
    <FormSection title={label}>
      {hint && <div className="text-[10px] text-zinc-500 -mt-1">{hint}</div>}
      <div className="space-y-1">
        {entries.map((entry, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="flex-1">
              {renderRow(entry, i, (next) => {
                const copy = entries.slice();
                copy[i] = next;
                onChange(copy);
              })}
            </div>
            <button
              type="button"
              onClick={() => {
                const copy = entries.slice();
                copy.splice(i, 1);
                onChange(copy);
              }}
              className="text-[10px] text-zinc-500 hover:text-red-400 pt-1"
              title="remove"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => onChange([...entries, newEntry()])}
          className="text-[10px] text-zinc-400 hover:text-zinc-200 px-2 py-0.5 border border-zinc-800 rounded"
        >
          + add
        </button>
      </div>
    </FormSection>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
}) {
  const cls =
    variant === 'primary'
      ? 'bg-emerald-700 hover:bg-emerald-600 border-emerald-600 text-white'
      : variant === 'danger'
        ? 'bg-red-900 hover:bg-red-800 border-red-800 text-red-100'
        : 'bg-zinc-800 hover:bg-zinc-700 border-zinc-700 text-zinc-100';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-xs px-2 py-1 rounded border ${cls} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {children}
    </button>
  );
}

const CONFIRM_TIMEOUT_MS = 4000;

export function ConfirmButton({
  children,
  onConfirm,
  variant = 'default',
  disabled,
}: {
  children: ReactNode;
  onConfirm: () => void;
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <Button
      variant={variant}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? 'Confirm' : children}
    </Button>
  );
}
