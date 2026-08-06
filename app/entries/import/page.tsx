/* eslint-disable @next/next/no-html-link-for-pages -- export links must trigger browser downloads */
import { Download, FileJson, FileText, Upload } from "lucide-react";
import type { Metadata } from "next";

import { beginPocketAuthorization, processQueuedImport, runImport } from "@/lib/actions";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Import & export" };

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ pocket?: string }> }) {
  const user = await requireUser();
  const [jobs, preference, query] = await Promise.all([
    db.importJob.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 12 }),
    db.userPreference.findUnique({ where: { userId: user.id }, select: { pocketConsumerKey: true } }),
    searchParams,
  ]);
  const pocketNotice = query.pocket === "queued"
    ? "Pocket authorized. The API import is queued safely."
    : query.pocket === "expired"
      ? "The Pocket authorization expired. Connect again."
      : query.pocket === "failed"
        ? "Pocket authorization failed. Check the consumer key and try again."
        : null;
  return (
    <div className="settings-page portability-page">
      <header className="settings-header"><p className="eyebrow">Your data stays portable</p><h1>Import & export</h1><p>Bring an existing library with you, or take a complete copy elsewhere.</p></header>
      <section className="portability-card">
        <div className="portability-title"><Upload size={20} /><div><h2>Import a library</h2><p>Auto-detect or identify the source. Existing URLs are skipped.</p></div></div>
        <form action={runImport} className="import-form">
          <label><span>Source</span><select name="source" defaultValue="auto"><option value="auto">Auto-detect</option><option value="wallabag">wallabag JSON</option><option value="pocket">Pocket CSV / HTML</option><option value="instapaper">Instapaper CSV</option><option value="readability">Readability JSON</option><option value="shaarli">Shaarli bookmarks HTML</option><option value="browser">Browser bookmarks HTML</option><option value="pinboard">Pinboard / Delicious JSON</option><option value="omnivore">Omnivore JSON</option><option value="elcurator">Elcurator JSON</option></select></label>
          <label className="file-picker"><span>Export file</span><input name="file" type="file" accept=".json,.csv,.html,.htm" required /></label>
          <button className="primary-button">Import entries</button>
        </form>
        <p className="import-note">Up to 5,000 entries or 20 MB per job. URL-only records are fetched through the extraction engine; content already embedded in the import file is sanitized without another network request.</p>
      </section>
      <section className="portability-card">
        <div className="portability-title"><Upload size={20} /><div><h2>Import from Pocket API</h2><p>Connect a retrieve-only Pocket application. OAuth tokens are encrypted and discarded when the durable job is hydrated.</p></div></div>
        {pocketNotice ? <p className={`form-notice ${query.pocket === "queued" ? "success" : "error"}`}>{pocketNotice}</p> : null}
        <form action={beginPocketAuthorization} className="import-form pocket-import-form">
          <label><span>Pocket consumer key</span><input name="consumerKey" defaultValue={preference?.pocketConsumerKey ?? ""} minLength={8} maxLength={200} autoComplete="off" required /></label>
          <label className="check-row"><input name="markAsRead" type="checkbox" value="1" /><span>Mark imported items as read</span></label>
          <button className="primary-button">Connect to Pocket</button>
        </form>
        <p className="import-note">Create a web application with retrieve permission in Pocket, then paste its consumer key here.</p>
      </section>
      <section className="portability-card">
        <div className="portability-title"><Download size={20} /><div><h2>Export your library</h2><p>Downloads include metadata, status, tags, notes, and content where the format supports it.</p></div></div>
        <div className="export-grid">
          <a href="/export/json?scope=all"><FileJson size={18} /><span><strong>JSON</strong><small>Best for round trips</small></span></a>
          <a href="/export/csv?scope=all"><FileText size={18} /><span><strong>CSV</strong><small>Library metadata</small></span></a>
          <a href="/export/xml?scope=all"><FileText size={18} /><span><strong>XML</strong><small>Structured archive</small></span></a>
          <a href="/export/epub?scope=all"><FileText size={18} /><span><strong>EPUB</strong><small>Offline e-book</small></span></a>
          <a href="/export/pdf?scope=all"><FileText size={18} /><span><strong>PDF</strong><small>Printable collection</small></span></a>
          <a href="/export/md?scope=all"><FileText size={18} /><span><strong>Markdown</strong><small>Readable text bundle</small></span></a>
          <a href="/export/txt?scope=all"><FileText size={18} /><span><strong>Plain text</strong><small>Universal fallback</small></span></a>
        </div>
      </section>
      <section className="portability-card">
        <div className="portability-title"><FileText size={20} /><div><h2>Recent imports</h2><p>Queued work survives restarts. Run a job here or keep <code>npm run import:worker</code> active.</p></div></div>
        <div className="job-list">
          {jobs.map((job) => <article key={job.id}><span className={`job-status ${job.status}`} /> <div><strong>{job.source}</strong><small>{job.createdAt.toLocaleString()}</small></div><p>{job.status} · {job.imported}/{job.total} imported{job.skipped ? ` · ${job.skipped} skipped` : ""}{job.failed ? ` · ${job.failed} failed` : ""}</p>{job.status === "pending" ? <form action={processQueuedImport.bind(null, job.id)}><button className="secondary-button">Run now</button></form> : null}{job.error ? <em>{job.error}</em> : null}</article>)}
          {!jobs.length ? <p className="muted">No import jobs yet.</p> : null}
        </div>
      </section>
    </div>
  );
}
