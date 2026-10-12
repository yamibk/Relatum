"""Check the build interpreter's note-search support without touching user data."""

import sqlite3
import sys
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from note_search import short_grams


def main():
    if sqlite3.sqlite_version_info < (3, 43, 0):
        raise RuntimeError("SQLite 3.43+ required; found " + sqlite3.sqlite_version)
    with closing(sqlite3.connect(":memory:")) as connection:
        connection.execute("create virtual table t using fts5(body,tokenize=trigram)")
        connection.execute(
            "create virtual table s using fts5("
            "body,content='',contentless_delete=1,detail=none,tokenize=ascii)"
        )
        connection.execute("insert into s values(?)", (short_grams("ab"),))
        count = connection.execute(
            "select count(*) from s where s match ?", ("g26162",)
        ).fetchone()[0]
        if count != 1:
            raise RuntimeError("Note short-query FTS5 check failed")
    print("Note SQLite/FTS5 preflight:", sqlite3.sqlite_version)


if __name__ == "__main__":
    main()
