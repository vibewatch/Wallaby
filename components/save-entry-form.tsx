"use client";

import { Link2, LoaderCircle } from "lucide-react";
import { useActionState, useId } from "react";

import { TagInput } from "@/components/tag-input";
import { addEntry } from "@/lib/actions";

type Props = {
  className?: string;
  defaultUrl?: string;
  defaultTags?: string;
  tagSuggestions?: string[];
  /** Used only if extraction cannot find a title, e.g. behind a paywall. */
  fallbackTitle?: string;
  autoFocus?: boolean;
};

/**
 * Extraction can take several seconds, so the form reports that it is working
 * and refuses a second submission meanwhile. A rejected address comes back as
 * an inline error with both fields still filled in.
 */
export function SaveEntryForm({ className, defaultUrl, defaultTags, tagSuggestions = [], fallbackTitle, autoFocus }: Props) {
  const [state, formAction, pending] = useActionState(addEntry, null);
  const errorId = useId();
  const url = state?.url ?? defaultUrl;
  const tags = state?.tags ?? defaultTags;
  return (
    <form action={formAction} aria-busy={pending} className={className}>
      {/* Not type="url": bare hosts such as example.com/story are accepted. */}
      <label className="url-field"><Link2 size={17} /><input
        type="text"
        inputMode="url"
        name="url"
        required
        autoComplete="url"
        autoFocus={autoFocus}
        placeholder="https://example.com/article"
        aria-label="Article URL"
        aria-invalid={state?.error ? true : undefined}
        aria-describedby={state?.error ? errorId : undefined}
        defaultValue={url}
        key={`url-${url ?? ""}`}
      /></label>
      <TagInput name="tags" placeholder="Tags, separated by commas" label="Tags" suggestions={tagSuggestions} defaultValue={tags} key={`tags-${tags ?? ""}`} />
      {fallbackTitle ? <input type="hidden" name="fallbackTitle" value={fallbackTitle} /> : null}
      <button className="primary-button" disabled={pending}>
        {pending ? <><LoaderCircle size={14} className="spin" aria-hidden /> Saving…</> : "Save & extract"}
      </button>
      {state?.error ? <p className="form-error" id={errorId} role="alert">{state.error}</p> : null}
    </form>
  );
}
