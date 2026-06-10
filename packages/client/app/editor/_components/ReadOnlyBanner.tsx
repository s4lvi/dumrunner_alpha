// Production banner. Saves return 403 in production builds; this
// surfaces the constraint before the author clicks Save.

export function ReadOnlyBanner() {
  if (process.env.NODE_ENV !== 'production') return null;
  return (
    <div className="px-3 py-1 text-[10px] text-amber-300 bg-amber-900/20 border-b border-amber-900/40 shrink-0">
      Read-only — author locally and redeploy.
    </div>
  );
}
