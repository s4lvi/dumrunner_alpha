// Dropdown over authored animations filtered by category.
// Used by the weapon / enemy / prop / biome editors to bind
// an entity to a library animation.

'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { AnimationCategory, AnimationDef } from '@dumrunner/shared';
import { listEntities } from '@/lib/editorContentClient';
import { FieldRow } from './Form';

export function AnimationPicker({
  label,
  category,
  value,
  onChange,
  hint,
  emptyLabel = '(none / static texture)',
}: {
  label: string;
  category: AnimationCategory;
  value: string | undefined | null;
  onChange: (v: string | undefined) => void;
  hint?: string;
  /** Label shown for the "no animation" option. */
  emptyLabel?: string;
}) {
  const [defs, setDefs] = useState<AnimationDef[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = (await listEntities('animations')) as AnimationDef[];
        if (!cancelled) setDefs(list);
      } catch {
        /* keep dropdown empty on fetch failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const options = useMemo(
    () =>
      defs
        .filter((d) => d.category === category)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [defs, category],
  );
  // Surface an unresolved value (manifest deleted or renamed)
  // so the author sees the stale reference instead of silently
  // dropping to "(none)".
  const valueResolves = !value || options.some((o) => o.id === value);
  return (
    <FieldRow
      label={label}
      hint={
        hint ?? (
          <>
            Library reference (
            <code className="text-zinc-300">{category}</code>
            -kind animations only). Author / edit at{' '}
            <Link
              href="/editor/animations"
              className="text-zinc-300 underline decoration-zinc-700 hover:decoration-zinc-400"
            >
              /editor/animations
            </Link>
            .
          </>
        )
      }
    >
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
      >
        <option value="">{emptyLabel}</option>
        {!valueResolves && value && (
          <option value={value} className="text-amber-300">
            {value} (unresolved)
          </option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}
