'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.SWARMBOARD_DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'swarmboard.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      archived INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS project_members (
      project_id TEXT REFERENCES projects(id),
      member_name TEXT NOT NULL,
      role TEXT DEFAULT 'contributor',
      PRIMARY KEY (project_id, member_name)
    );

    CREATE TABLE IF NOT EXISTS status_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT REFERENCES projects(id),
      author TEXT NOT NULL,
      status_text TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      method TEXT DEFAULT 'POST',
      headers_json TEXT,
      body_template TEXT,
      enabled INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS project_hooks (
      project_id TEXT REFERENCES projects(id),
      hook_id TEXT REFERENCES hooks(id),
      event_filter TEXT,
      enabled INTEGER DEFAULT 1,
      PRIMARY KEY (project_id, hook_id)
    );

    CREATE TABLE IF NOT EXISTS hook_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT,
      hook_id TEXT,
      event_type TEXT,
      status_code INTEGER,
      response_body TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { getDb, DB_PATH };
