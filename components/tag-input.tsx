"use client";

import { useId, useMemo, useState } from "react";

import { applyTagSuggestion, matchTagSuggestions } from "@/lib/tag-suggestions";

type Props = {
  name: string;
  /** The reader's existing tag labels, most used first. */
  suggestions: string[];
  defaultValue?: string;
  placeholder?: string;
  label: string;
  required?: boolean;
};

/**
 * A comma-separated tag field that suggests existing tags for the segment
 * being typed. A `<datalist>` would only ever match the whole value, so it
 * stops helping after the first comma.
 */
export function TagInput({ name, suggestions, defaultValue = "", placeholder, label, required }: Props) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const matches = useMemo(() => matchTagSuggestions(value, suggestions), [suggestions, value]);
  const expanded = open && matches.length > 0;

  const choose = (suggestion: string) => {
    setValue(applyTagSuggestion(value, suggestion));
    setActive(-1);
    setOpen(false);
  };

  return (
    <div className="tag-input">
      <input
        type="text"
        name={name}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        required={required}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={listId}
        aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
        onChange={(event) => { setValue(event.target.value); setActive(-1); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (!expanded) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((current) => (current >= matches.length - 1 ? 0 : current + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => (current <= 0 ? matches.length - 1 : current - 1));
          } else if (event.key === "Enter" && active >= 0 && active < matches.length) {
            event.preventDefault();
            choose(matches[active]);
          } else if (event.key === "Escape") {
            // Only the list closes; the key must not also leave the field.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <ul role="listbox" id={listId} hidden={!expanded} aria-label={`${label} suggestions`}>
        {matches.map((suggestion, index) => (
          <li
            key={suggestion}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === active}
            // Keep focus in the field so typing can continue after a choice.
            onMouseDown={(event) => { event.preventDefault(); choose(suggestion); }}
          >
            {suggestion}
          </li>
        ))}
      </ul>
    </div>
  );
}
