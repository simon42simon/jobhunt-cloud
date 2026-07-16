import type { ReactNode } from "react";

// The ONE segmented-control dialect (UI consistency pack t-1783183576693).
// Before this, three visual dialects coexisted: TopBar's accent-fill pill,
// TaskBoard's panel-pill-with-shadow group toggle, and JobFilterBar's All/Any
// combinator. The accent-fill pill (active = solid --color-accent with white
// text, in a panel-2 well) is canonical; the others migrate here.
//
// Semantics match the app's existing idiom: a role="group" of aria-pressed
// buttons (NOT tabs - these switch a view/mode in place, they do not own a
// tabpanel). Buttons are 44px tap targets on touch, relaxed at >= sm, per the
// app-wide phone-fit idiom (min-h-[44px] ... sm:min-h-0).

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  title?: string;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  size = "sm",
  className = "",
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
  // md = TopBar-scale (13px, roomier padding); sm = inline toolbars (12px).
  size?: "sm" | "md";
  className?: string;
}) {
  const wellCls = size === "md" ? "gap-1 rounded-lg p-1" : "gap-0.5 rounded-md p-0.5";
  const btnSize = size === "md" ? "rounded-md px-3 py-1.5 text-[13px]" : "rounded px-2.5 py-1 text-[12px]";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex items-center bg-[var(--color-panel-2)] ${wellCls} ${className}`.trim()}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`inline-flex min-h-[44px] shrink-0 items-center justify-center whitespace-nowrap font-medium transition sm:min-h-0 ${btnSize} ${
              on
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
