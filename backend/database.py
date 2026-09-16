"""SQLite 数据访问层。"""
import os
import sqlite3
from contextlib import contextmanager

DB_PATH = os.environ.get("APP_DB_PATH", "data/cues.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS cues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    name TEXT NOT NULL,
    duration INTEGER NOT NULL CHECK (duration > 0),
    locked_start INTEGER CHECK (locked_start IS NULL OR locked_start >= 0)
);
CREATE TABLE IF NOT EXISTS dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cue_id INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
    depends_on INTEGER NOT NULL REFERENCES cues(id) ON DELETE CASCADE,
    delay INTEGER NOT NULL DEFAULT 0 CHECK (delay >= 0),
    UNIQUE (cue_id, depends_on)
);
"""


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    db_dir = os.path.dirname(os.path.abspath(DB_PATH))
    os.makedirs(db_dir, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(_SCHEMA)
