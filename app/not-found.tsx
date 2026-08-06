import Link from "next/link";

export default function NotFoundPage() {
  return (
    <main className="status-page">
      <p className="eyebrow">Page not found</p>
      <h1>This page is no longer on the shelf.</h1>
      <p>The link may have expired, been revoked, or moved somewhere else in your library.</p>
      <div><Link className="primary-button" href="/entries">Return to library</Link><Link className="secondary-button" href="/entries/help">Open help</Link></div>
    </main>
  );
}
