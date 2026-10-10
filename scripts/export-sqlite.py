#!/usr/bin/env python3
"""Export a stopped SQLite application database, never its search/migration metadata."""
import json
from pathlib import Path
import sqlite3
import sys

source, destination = map(Path, sys.argv[1:])
connection = sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True)
connection.row_factory = sqlite3.Row
try:
    names = [row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' "
        "AND name NOT LIKE 'EntrySearch%' AND name NOT LIKE 'sqlite_%' "
        "AND name != '_prisma_migrations' ORDER BY name"
    )]
    tables = {}
    for name in names:
        escaped = name.replace('"', '""')
        tables[name] = [dict(row) for row in connection.execute(f'SELECT * FROM "{escaped}"')]
    with destination.open("x") as output:
        json.dump(tables, output, ensure_ascii=False)
finally:
    connection.close()
