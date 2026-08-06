import Link from "next/link";

export default function EntryNotFound() {
  return <div className="empty-state full-empty"><span>∿</span><h1>Entry not found</h1><p>It may have been deleted or belong to another library.</p><Link className="primary-button" href="/entries">Return to your library</Link></div>;
}
