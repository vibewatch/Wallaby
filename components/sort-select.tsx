"use client";

import { ArrowDownUp } from "lucide-react";
import Form from "next/form";

import { entrySortLabel, entrySortOptions, type EntrySort } from "@/lib/entry-sort";

type Props = {
  value: EntrySort;
  searching: boolean;
  /** Every other active filter, so changing the order keeps the same results. */
  params: [string, string][];
};

/** Reorders immediately on change; the fallback button covers browsers without JavaScript. */
export function SortSelect({ value, searching, params }: Props) {
  return (
    <Form action="/entries" className="sort-select">
      {params.map(([name, paramValue]) => <input key={name} type="hidden" name={name} value={paramValue} />)}
      <label>
        <ArrowDownUp size={13} aria-hidden />
        <select name="sort" aria-label="Sort entries" defaultValue={value} key={value} onChange={(event) => event.currentTarget.form?.requestSubmit()}>
          {searching ? <option value="relevance">{entrySortLabel("relevance")}</option> : null}
          {entrySortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <noscript><button className="secondary-button">Sort</button></noscript>
    </Form>
  );
}
