const express = require('express');
const router = express.Router();
const db = require('../db');

// POST /optouts
router.post('/', (req, res) => {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ error: 'sessionId and phone are required' });
    
    try {
        db.prepare(`INSERT OR IGNORE INTO optouts (phone, sessionId, createdAt) VALUES (?, ?, ?)`).run(phone, sessionId, new Date().toISOString());
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /optouts
router.delete('/', (req, res) => {
    const { sessionId, phone } = req.body;
    if (!sessionId || !phone) return res.status(400).json({ error: 'sessionId and phone are required' });
    
    try {
        db.prepare(`DELETE FROM optouts WHERE phone = ? AND sessionId = ?`).run(phone, sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /optouts?sessionId=
router.get('/', (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: 'sessionId query param is required' });
    
    try {
        const rows = db.prepare(`SELECT * FROM optouts WHERE sessionId = ?`).all(sessionId);
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
