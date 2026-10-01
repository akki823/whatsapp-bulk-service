const express = require('express');
const router = express.Router();
const sessionManager = require('../whatsapp/sessionManager');

// Helper to validate sessionId
function isValidSessionId(id) {
    return /^[a-zA-Z0-9_-]{1,50}$/.test(id);
}

// Middleware to check sessionId validity
function checkSessionIdParam(req, res, next) {
    const id = req.params.id || req.body.sessionId;
    if (!id) {
        return res.status(400).json({ error: 'sessionId is required' });
    }
    if (!isValidSessionId(id)) {
        return res.status(400).json({ error: 'Invalid sessionId format' });
    }
    next();
}

// GET /sessions
router.get('/sessions', (req, res) => {
    const sessions = sessionManager.getAllSessions();
    res.json(sessions);
});

// POST /sessions
router.post('/sessions', checkSessionIdParam, async (req, res) => {
    const { sessionId } = req.body;
    try {
        const result = await sessionManager.startSession(sessionId);
        res.json(result);
    } catch (error) {
        console.error('Error starting session:', error);
        res.status(500).json({ error: 'Failed to start session' });
    }
});

// GET /sessions/:id
router.get('/sessions/:id', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    const session = sessionManager.getSessionData(id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
});

// GET /sessions/:id/status
router.get('/sessions/:id/status', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    const status = sessionManager.getSessionStatus(id);
    res.json({ sessionId: id, status });
});

// GET /sessions/:id/qr
router.get('/sessions/:id/qr', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    const qr = sessionManager.getSessionQr(id);
    if (!qr) {
        return res.status(404).json({ error: 'QR not available or session connected/disconnected' });
    }
    res.json({ sessionId: id, qr });
});

// GET /sessions/:id/qr-page
router.get('/sessions/:id/qr-page', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    const key = req.query.key || '';
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Scan QR - ${id}</title>
        <meta http-equiv="refresh" content="3">
    </head>
    <body style="display:flex; justify-content:center; align-items:center; height:100vh; background-color:#f0f2f5; font-family:sans-serif;">
        <div style="background:white; padding:40px; border-radius:10px; box-shadow:0 4px 12px rgba(0,0,0,0.1); text-align:center;">
            <h2>Scan with WhatsApp</h2>
            <p>Session: <strong>${id}</strong></p>
            <div id="qr-container">
                <img src="/sessions/${id}/qr?key=${key}" alt="QR Code" id="qr-img" style="max-width:300px; display:none; margin: 0 auto;" />
                <p id="status-text">Loading QR...</p>
            </div>
            <script>
                fetch('/sessions/${id}/qr?key=${key}')
                    .then(res => {
                        if (!res.ok) throw new Error('Not available');
                        return res.json();
                    })
                    .then(data => {
                        if (data.qr) {
                            document.getElementById('qr-img').src = data.qr;
                            document.getElementById('qr-img').style.display = 'block';
                            document.getElementById('status-text').style.display = 'none';
                        }
                    })
                    .catch(() => {
                        document.getElementById('status-text').innerText = 'No QR available. Waiting or connected?';
                        document.getElementById('qr-img').style.display = 'none';
                    });
            </script>
        </div>
    </body>
    </html>
    `;
    res.send(html);
});

// DELETE /sessions/:id
router.delete('/sessions/:id', checkSessionIdParam, async (req, res) => {
    const { id } = req.params;
    const success = await sessionManager.logoutSession(id);
    if (!success) {
        return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ success: true });
});

// POST /sessions/:id/reconnect
router.post('/sessions/:id/reconnect', checkSessionIdParam, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await sessionManager.reconnectSession(id);
        res.json(result);
    } catch (error) {
        console.error('Error reconnecting session:', error);
        res.status(400).json({ error: error.message || 'Failed to reconnect session' });
    }
});

// PUT /sessions/:id/webhook
router.put('/sessions/:id/webhook', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    const { url } = req.body;
    if (!url || !url.match(/^https?:\/\//)) {
        return res.status(400).json({ error: 'Valid url starting with http or https is required' });
    }
    try {
        const db = require('../db');
        db.prepare(`INSERT INTO session_webhooks (sessionId, url) VALUES (?, ?) ON CONFLICT(sessionId) DO UPDATE SET url = ?`).run(id, url, url);
        res.json({ success: true, url });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// GET /sessions/:id/webhook
router.get('/sessions/:id/webhook', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    try {
        const db = require('../db');
        const row = db.prepare(`SELECT url FROM session_webhooks WHERE sessionId = ?`).get(id);
        res.json({ url: row ? row.url : null });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// POST /send-test
router.post('/send-test', checkSessionIdParam, async (req, res) => {
    const { sessionId, to, text } = req.body;
    
    if (!sessionId || !to || !text) {
        return res.status(400).json({ error: 'sessionId, to, and text are required' });
    }

    try {
        const result = await sessionManager.sendMessage(sessionId, to, text);
        res.json({ success: true, messageId: result?.key?.id });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ error: error.message || 'Failed to send message' });
    }
});

// POST /sessions/:id/warmup/start
router.post('/sessions/:id/warmup/start', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    try {
        const db = require('../db');
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO session_settings (sessionId, warmupEnabled, warmupStartedAt) VALUES (?, 1, ?) 
            ON CONFLICT(sessionId) DO UPDATE SET warmupEnabled = 1, warmupStartedAt = ?`).run(id, now, now);
        res.json({ success: true, warmupEnabled: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// POST /sessions/:id/warmup/stop
router.post('/sessions/:id/warmup/stop', checkSessionIdParam, (req, res) => {
    const { id } = req.params;
    try {
        const db = require('../db');
        db.prepare(`UPDATE session_settings SET warmupEnabled = 0 WHERE sessionId = ?`).run(id);
        res.json({ success: true, warmupEnabled: false });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /sessions/:id/warmup
router.get('/sessions/:id/warmup', checkSessionIdParam, async (req, res) => {
    const { id } = req.params;
    try {
        const db = require('../db');
        const queueManager = require('../queue');
        const settings = db.prepare('SELECT warmupEnabled, warmupStartedAt FROM session_settings WHERE sessionId = ?').get(id);
        
        let enabled = false;
        let startedAt = null;
        let currentDay = null;

        if (settings && settings.warmupEnabled && settings.warmupStartedAt) {
            enabled = true;
            startedAt = settings.warmupStartedAt;
            const diffTime = Math.abs(new Date() - new Date(startedAt));
            currentDay = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
        }
        
        const todaysLimit = await queueManager.getDailyLimit(id);
        
        res.json({ enabled, startedAt, currentDay, todaysLimit });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;
