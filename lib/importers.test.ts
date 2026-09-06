import { describe, expect, it } from "vitest";

import { parseImport } from "./importers";

describe("portable library importers", () => {
  it("normalizes a wallabag JSON export with content, status, tags, and dates", () => {
    const entries = parseImport("wallabag", "wallabag.json", JSON.stringify([{
      url: "https://example.com/story",
      title: "Saved story",
      content: "<p>Offline copy</p>",
      tags: [{ label: "Research" }, { label: "Long read" }],
      is_archived: 1,
      is_starred: 0,
      created_at: "2024-02-03T10:20:00Z",
      origin_url: "https://source.example/link-roundup",
      published_by: ["Ada Reader"],
      annotations: [{ text: "Keep this", quote: "Offline copy", ranges: [{ start: "0/0", startOffset: 0, end: "0/0", endOffset: 12 }] }],
    }]));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      url: "https://example.com/story",
      title: "Saved story",
      content: "<p>Offline copy</p>",
      tags: ["Research", "Long read"],
      archived: true,
      starred: false,
      originUrl: "https://source.example/link-roundup",
      publishedBy: ["Ada Reader"],
      annotations: [{ text: "Keep this", quote: "Offline copy", ranges: [{ start: "0/0", startOffset: 0, end: "0/0", endOffset: 12 }] }],
    });
    expect(entries[0].createdAt?.toISOString()).toBe("2024-02-03T10:20:00.000Z");
  });

  it("handles quoted Pocket CSV fields and timestamps", () => {
    const entries = parseImport("pocket", "pocket.csv", 'title,url,time_added,tags,status\r\n"Title, with comma",https://example.com/pocket,1700000000,"news,tech",archive');
    expect(entries[0].title).toBe("Title, with comma");
    expect(entries[0].tags).toEqual(["news", "tech"]);
    expect(entries[0].archived).toBe(true);
    expect(entries[0].createdAt?.getUTCFullYear()).toBe(2023);
  });

  it.each([
    { source: "pocket" as const, filename: "pocket.html" },
    { source: "pocket" as const, filename: "uploaded-export" },
    { source: "auto" as const, filename: "pocket.html" },
    { source: "auto" as const, filename: "export.html" },
  ])("preserves Pocket HTML state and timestamps with $source detection for $filename", ({ source, filename }) => {
    const entries = parseImport(source, filename, `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>
      <h1>Unread</h1><ul><li><a href="https://example.com/unread" time_added="1700000000" tags="news,tech">Unread story</a></li></ul>
      <h1>Read Archive</h1><ul><li><a href="https://example.com/archived" time_added="1700000010" tags="reference">Finished story</a></li></ul>
    </body></html>`);

    expect(entries).toMatchObject([
      { url: "https://example.com/unread", title: "Unread story", tags: ["news", "tech"], archived: false },
      { url: "https://example.com/archived", title: "Finished story", tags: ["reference"], archived: true },
    ]);
    expect(entries.map((entry) => entry.createdAt?.toISOString())).toEqual(["2023-11-14T22:13:20.000Z", "2023-11-14T22:13:30.000Z"]);
  });

  it("reads Netscape browser bookmark HTML", () => {
    const entries = parseImport("browser", "bookmarks.html", '<!DOCTYPE NETSCAPE-Bookmark-file-1><a href="https://example.com/bookmark" add_date="1700000000" tags="reference,web">Bookmark</a>');
    expect(entries[0]).toMatchObject({ title: "Bookmark", tags: ["reference", "web"] });
  });

  it("normalizes an upstream-shaped Readability bookmark export", () => {
    const entries = parseImport("readability", "readability.json", JSON.stringify({ bookmarks: [{
      article__url: "https://example.com/readability",
      article__title: "A Readability story",
      archive: true,
      favorite: false,
      date_added: "2016-08-25T12:05:00",
    }] }));

    expect(entries[0]).toMatchObject({
      url: "https://example.com/readability",
      title: "A Readability story",
      archived: true,
      starred: false,
    });
    expect(entries[0].createdAt?.getFullYear()).toBe(2016);
  });

  it("preserves Shaarli tags and timestamps from its bookmark HTML", () => {
    const input = '<!DOCTYPE NETSCAPE-Bookmark-file-1><h1>Shaarli export of all bookmarks</h1><a href="https://example.com/shaarli" add_date="1686813518" tags="firefoxos,reference">Saved link</a>';
    const entries = parseImport("auto", "bookmarks.html", input);

    expect(entries[0]).toMatchObject({
      url: "https://example.com/shaarli",
      title: "Saved link",
      tags: ["firefoxos", "reference"],
    });
    expect(entries[0].createdAt?.toISOString()).toBe("2023-06-15T07:18:38.000Z");
  });

  it("maps Elcurator saved state and detects its JSON signature", () => {
    const entries = parseImport("auto", "export.json", JSON.stringify([{
      url: "https://example.com/elcurator",
      title: "Curated story",
      created_at: "2015-09-09 11:10:32 UTC",
      tags: ["tag1", "tag2"],
      is_saved: true,
    }]));

    expect(entries[0]).toMatchObject({
      url: "https://example.com/elcurator",
      title: "Curated story",
      tags: ["tag1", "tag2"],
      archived: false,
      starred: true,
    });
    expect(entries[0].createdAt?.toISOString()).toBe("2015-09-09T11:10:32.000Z");
  });
});
