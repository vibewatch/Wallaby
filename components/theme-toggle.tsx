"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useOptimistic, useTransition } from "react";

import { saveTheme } from "@/lib/actions";
import type { Theme } from "@/lib/theme";

const options: { value: Theme; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "auto", label: "Match system", Icon: Monitor },
];

/**
 * Applies the palette optimistically on the document so switching is instant,
 * then persists it. The server action is what makes the choice survive a new
 * browser; the DOM write is what makes it feel immediate. The pre-paint script
 * in the root layout owns the system-preference listener and reads
 * `data-theme-preference`, so writing that attribute is enough to hand over.
 */
export function ThemeToggle({ theme }: { theme: Theme }) {
  const [current, setCurrent] = useOptimistic(theme);
  const [, startTransition] = useTransition();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.themePreference = current;
    root.dataset.theme = current === "auto"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : current;
  }, [current]);

  function choose(next: Theme) {
    startTransition(async () => {
      setCurrent(next);
      await saveTheme(next);
    });
  }

  const active = options.find((option) => option.value === current) ?? options[2];

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className={value === current ? "active" : ""}
          aria-pressed={value === current}
          title={label}
          onClick={() => choose(value)}
        >
          <Icon size={15} />
          <span className="visually-hidden">{label}</span>
        </button>
      ))}
      <span className="visually-hidden" aria-live="polite">{active.label} theme selected</span>
    </div>
  );
}
