const express = require('express');
const router = express.Router();
const queueManager = require('../queue');

function isValidSessionId(id) {
    return /^[a-zA-Z0-9_-]{1,50}$/.test(id);
}

function checkSessionIdParam(req, res, next) {
    const id = req.params.sessionId;
    if (!id) return res.status(400).json({ error: 'sessionId is required' });
    if (!isValidSessionId(id)) return res.status(400).json({ error: 'Invalid sessionId format' });
    next();
}

function isValidPhone(phone) {
    return /^\d{10,15}$/.test(phone);
}

router.post('/:sessionId/messages', checkSessionIdParam, async (req, res) => {
    const { sessionId } = req.params;
    const { messages } = req.body;
    
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
        return res.status(400).json({ error: 'messages must be a non-empty array of max 100 items' });
    }

    const validMessages = [];
    for (const msg of messages) {
        if (!msg.to || !msg.text || !isValidPhone(msg.to)) {
            return res.status(400).json({ error: `Invalid message format or phone number: ${JSON.stringify(msg)}` });
        }
        validMessages.push(msg);
    }

    try {
        const queuedCount = await queueManager.addMessagesToQueue(sessionId, validMessages);
        res.json({ queued: queuedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:sessionId/stats', checkSessionIdParam, async (req, res) => {
    try {
        const stats = await queueManager.getQueueStats(req.params.sessionId);
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:sessionId/pause', checkSessionIdParam, async (req, res) => {
    try {
        await queueManager.pauseQueue(req.params.sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:sessionId/resume', checkSessionIdParam, async (req, res) => {
    try {
        await queueManager.resumeQueue(req.params.sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:sessionId', checkSessionIdParam, async (req, res) => {
    try {
        await queueManager.removeAllWaitingJobs(req.params.sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:sessionId/limit', checkSessionIdParam, async (req, res) => {
    const { dailyLimit } = req.body;
    if (typeof dailyLimit !== 'number' || dailyLimit < 0) {
        return res.status(400).json({ error: 'dailyLimit must be a non-negative number' });
    }
    try {
        await queueManager.setDailyLimit(req.params.sessionId, dailyLimit);
        res.json({ success: true, dailyLimit });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
