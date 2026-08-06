"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useRef, useState } from "react";

type RangeSelector = { start: string; startOffset: number; end: string; endOffset: number };
type HighlightAnnotation = { id: string; quote: string; ranges: RangeSelector[] };
type PendingSelection = { quote: string; range: RangeSelector };

export function ArticleAnnotator({ entryId, html, annotations }: { entryId: string; html: string; annotations: HighlightAnnotation[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = html;
    const highlights = annotations.flatMap((annotation) => {
      const selector = annotation.ranges[0];
      const range = (selector ? rangeFromSelector(root, selector) : null) ?? quoteRange(root, annotation.quote);
      return range ? [{ annotation, range }] : [];
    });
    highlights.sort((left, right) => right.range.compareBoundaryPoints(Range.START_TO_START, left.range));
    for (const { annotation, range } of highlights) {
      try {
        const mark = document.createElement("mark");
        mark.className = "annotation-highlight";
        mark.dataset.annotationId = annotation.id;
        mark.title = annotation.quote;
        mark.append(range.extractContents());
        range.insertNode(mark);
      } catch {
        // A stale selector should never make the article unreadable.
      }
    }
  }, [annotations, html]);

  useEffect(() => {
    function handleSelectionChange() {
      const root = rootRef.current;
      const pending = root ? pendingSelection(root) : null;
      if (pending) {
        setSelection(pending);
        setNote("");
        setError(null);
      }
    }
    document.addEventListener("selectionchange", handleSelectionChange);
    rootRef.current?.setAttribute("data-annotator-ready", "true");
    return () => document.removeEventListener("selectionchange", handleSelectionChange);
  }, []);

  function captureSelection() {
    const root = rootRef.current;
    const pending = root ? pendingSelection(root) : null;
    if (!pending) return;
    setSelection(pending);
    setNote("");
    setError(null);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection || !note.trim() || saving) return;
    setSaving(true);
    setError(null);
    const response = await fetch(`/api/annotations/${entryId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: note.trim(), quote: selection.quote, ranges: [selection.range] }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: string } | null;
      setError(body?.error ?? "The highlight could not be saved");
      setSaving(false);
      return;
    }
    window.getSelection()?.removeAllRanges();
    setSelection(null);
    setNote("");
    setSaving(false);
    router.refresh();
  }

  return (
    <>
      <div ref={rootRef} className="article-content" data-annotator-ready="false" onMouseUp={captureSelection} dangerouslySetInnerHTML={{ __html: html }} />
      {selection ? <aside className="selection-annotation" role="dialog" aria-label="New highlight">
        <form onSubmit={save}>
          <strong>Annotate selection</strong>
          <blockquote>{selection.quote}</blockquote>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Why does this matter?" aria-label="Highlight note" rows={3} required autoFocus />
          {error ? <p role="alert">{error}</p> : null}
          <div><button type="button" onClick={() => setSelection(null)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save highlight"}</button></div>
        </form>
      </aside> : null}
    </>
  );
}

function pendingSelection(root: Node): PendingSelection | null {
  const browserSelection = window.getSelection();
  if (!browserSelection || browserSelection.rangeCount !== 1 || browserSelection.isCollapsed) return null;
  const range = browserSelection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const quote = browserSelection.toString().replace(/\s+/g, " ").trim().slice(0, 10_000);
  return quote ? { quote, range: selectorFromRange(root, range) } : null;
}

function selectorFromRange(root: Node, range: Range): RangeSelector {
  return {
    start: pathForNode(root, range.startContainer),
    startOffset: range.startOffset,
    end: pathForNode(root, range.endContainer),
    endOffset: range.endOffset,
  };
}

function pathForNode(root: Node, node: Node): string {
  const indexes: number[] = [];
  let current: Node | null = node;
  while (current && current !== root) {
    const parent: Node | null = current.parentNode;
    if (!parent) break;
    indexes.push(Array.prototype.indexOf.call(parent.childNodes, current) as number);
    current = parent;
  }
  return indexes.reverse().join("/");
}

function rangeFromSelector(root: Node, selector: RangeSelector): Range | null {
  const start = nodeAtPath(root, selector.start);
  const end = nodeAtPath(root, selector.end);
  if (!start || !end || selector.startOffset > nodeLength(start) || selector.endOffset > nodeLength(end)) return null;
  try {
    const range = document.createRange();
    range.setStart(start, selector.startOffset);
    range.setEnd(end, selector.endOffset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

function nodeAtPath(root: Node, path: string): Node | null {
  let node: Node = root;
  if (!path) return node;
  for (const part of path.split("/")) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 0 || !node.childNodes[index]) return null;
    node = node.childNodes[index];
  }
  return node;
}

function nodeLength(node: Node): number {
  return node.nodeType === Node.TEXT_NODE ? node.textContent?.length ?? 0 : node.childNodes.length;
}

function quoteRange(root: Node, quote: string): Range | null {
  if (!quote) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const index = node.textContent?.indexOf(quote) ?? -1;
    if (index >= 0) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + quote.length);
      return range;
    }
    node = walker.nextNode();
  }
  return null;
}
