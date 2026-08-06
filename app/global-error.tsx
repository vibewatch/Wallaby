"use client";

import Link from "next/link";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="status-page">
          <p className="eyebrow">Wallaby needs a fresh start</p>
          <h1>The application could not render this page.</h1>
          <p>Retry once. If the problem remains, check the server health endpoint and structured error log.</p>
          <div><button onClick={reset}>Try again</button><Link href="/">Open Wallaby</Link></div>
        </main>
      </body>
    </html>
  );
}
