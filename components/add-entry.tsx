import { Plus } from "lucide-react";

import { SaveEntryForm } from "@/components/save-entry-form";

export function AddEntry({ tagSuggestions }: { tagSuggestions: string[] }) {
  return (
    <details className="add-entry">
      <summary><Plus size={17} /> Save an article</summary>
      <SaveEntryForm tagSuggestions={tagSuggestions} />
    </details>
  );
}
