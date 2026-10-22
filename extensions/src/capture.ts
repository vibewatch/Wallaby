import { Readability } from "@mozilla/readability";

export function capture() {
  const clone = document.cloneNode(true);
  if (!(clone instanceof Document)) throw new Error("This page cannot be read.");
  for (const control of clone.querySelectorAll("form,input,textarea,select,button")) control.remove();
  const article = new Readability(clone, { maxElemsToParse: 50_000 }).parse();
  if (!article?.content || (article.textContent?.trim().length ?? 0) < 100) throw new Error("No readable article was found on this page. Try saving its address instead.");
  if (new TextEncoder().encode(article.content).length > 5_000_000) throw new Error("This article is too large to capture. Save its address instead.");
  return { url: location.href, content: article.content };
}
