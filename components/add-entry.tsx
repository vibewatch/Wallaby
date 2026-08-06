import { Link2, Plus } from "lucide-react";

import { addEntry } from "@/lib/actions";

export function AddEntry() {
  return (
    <details className="add-entry">
      <summary><Plus size={17} /> Save an article</summary>
      <form action={addEntry}>
        <label className="url-field"><Link2 size={17} /><input type="url" name="url" required placeholder="https://example.com/article" aria-label="Article URL" /></label>
        <input type="text" name="tags" placeholder="Tags, separated by commas" aria-label="Tags" />
        <button className="primary-button">Save & extract</button>
      </form>
    </details>
  );
}
