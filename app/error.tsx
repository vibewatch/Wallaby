"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return (
    <main className="status-page">
      <p className="eyebrow">Something interrupted the reading room</p>
      <h1>Wallaby could not finish that request.</h1>
      <p>Your library is still safe. Try the request again, or return to the library if the problem continues.</p>
      {error.digest ? <small>Reference: {error.digest}</small> : null}
      <div><button className="primary-button" onClick={reset}>Try again</button><Link className="secondary-button" href="/entries">Return to library</Link></div>
    </main>
  );
}
