const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(path.join(DATA_DIR, 'service.db'));

db.pragma('journal_mode = WAL');

// init tables
db.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        name TEXT NOT NULL,
        template TEXT NOT NULL,
        status TEXT NOT NULL,
        consentConfirmed INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        startedAt TEXT,
        finishedAt TEXT
    );

    CREATE TABLE IF NOT EXISTS recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaignId INTEGER NOT NULL,
        sessionId TEXT,
        phone TEXT NOT NULL,
        name TEXT,
        status TEXT NOT NULL,
        error TEXT,
        sentAt TEXT,
        FOREIGN KEY(campaignId) REFERENCES campaigns(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS optouts (
        phone TEXT NOT NULL,
        sessionId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (phone, sessionId)
    );

    CREATE TABLE IF NOT EXISTS session_webhooks (
        sessionId TEXT PRIMARY KEY,
        url TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_settings (
        sessionId TEXT PRIMARY KEY,
        warmupEnabled INTEGER DEFAULT 0,
        warmupStartedAt TEXT
    );
`);

try {
    db.exec(`ALTER TABLE recipients ADD COLUMN sessionId TEXT`);
} catch (e) {
    // ignore if already exists
}

module.exports = db;
