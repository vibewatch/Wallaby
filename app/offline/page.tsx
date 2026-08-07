import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Offline" };

/**
 * Served by the service worker when a navigation cannot reach the server. Kept
 * static and free of user data so it works while signed out and stays safe in
 * the cache.
 */
export default function OfflinePage() {
  return (
    <main className="status-page">
      <p className="eyebrow">No connection</p>
      <h1>Wallaby is waiting for the network.</h1>
      <p>Your library lives on your own server, so it needs a connection to reach it. Everything you have saved is still there.</p>
      <div><Link className="primary-button" href="/entries">Try again</Link></div>
    </main>
  );
}
