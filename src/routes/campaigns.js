const express = require('express');
const router = express.Router();
const db = require('../db');
const queueManager = require('../queue');

function isValidPhone(phone) {
    return /^\d{10,15}$/.test(phone);
}

function renderTemplate(template, name) {
    let t = template.replace(/{name}/gi, name || 'there');
    t = t.replace(/{([^}]+)}/g, (match, contents) => {
        if (contents.includes('|')) {
            const parts = contents.split('|');
            return parts[Math.floor(Math.random() * parts.length)];
        }
        return match;
    });
    return t;
}

// POST /campaigns
router.post('/', (req, res) => {
    const { sessionId, sessionIds, name, template, consentConfirmed, contacts } = req.body;
    
    let sessions = [];
    if (Array.isArray(sessionIds) && sessionIds.length > 0) {
        sessions = sessionIds;
    } else if (sessionId) {
        sessions = [sessionId];
    }
    
    if (sessions.length === 0 || !name || !template) {
        return res.status(400).json({ error: 'sessionId (or sessionIds), name, and template are required' });
    }
    
    if (consentConfirmed !== true) {
        return res.status(400).json({ error: 'consentConfirmed must be exactly true' });
    }

    if (!Array.isArray(contacts) || contacts.length === 0 || contacts.length > 1000) {
        return res.status(400).json({ error: 'contacts must be a non-empty array of max 1000 items' });
    }

    const uniquePhones = new Set();
    const validContacts = [];

    for (const c of contacts) {
        if (c.phone && isValidPhone(c.phone) && !uniquePhones.has(c.phone)) {
            uniquePhones.add(c.phone);
            validContacts.push(c);
        }
    }

    if (validContacts.length === 0) {
        return res.status(400).json({ error: 'No valid contacts provided' });
    }

    const storedSessionId = JSON.stringify(sessions);

    const stmtCampaign = db.prepare(`INSERT INTO campaigns (sessionId, name, template, status, consentConfirmed, createdAt) VALUES (?, ?, ?, ?, ?, ?)`);
    const stmtRecipient = db.prepare(`INSERT INTO recipients (campaignId, phone, name, status) VALUES (?, ?, ?, ?)`);
    
    let campaignId;
    
    const insertTransaction = db.transaction(() => {
        const result = stmtCampaign.run(storedSessionId, name, template, 'draft', 1, new Date().toISOString());
        campaignId = result.lastInsertRowid;
        for (const c of validContacts) {
            stmtRecipient.run(campaignId, c.phone, c.name || null, 'pending');
        }
    });

    try {
        insertTransaction();
        res.json({ id: campaignId, status: 'draft', recipientsCount: validContacts.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /campaigns/:id/start
router.post('/:id/start', async (req, res) => {
    const { id } = req.params;
    const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id);
    
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'draft') return res.status(400).json({ error: 'Campaign is already started or completed' });

    let targetSessions = [];
    try {
        const parsed = JSON.parse(campaign.sessionId);
        if (Array.isArray(parsed)) targetSessions = parsed;
        else targetSessions = [campaign.sessionId];
    } catch(e) {
        targetSessions = [campaign.sessionId];
    }

    const sessionManager = require('../whatsapp/sessionManager');
    
    const activeSessions = [];
    for (const sid of targetSessions) {
        const status = sessionManager.getSessionStatus(sid);
        if (status !== 'connected') {
            console.warn(`Skipping session ${sid} for campaign ${id}: not connected`);
            continue;
        }
        const limit = await queueManager.getDailyLimit(sid);
        const count = await queueManager.getDailyCount(sid);
        if (count >= limit) {
            console.warn(`Skipping session ${sid} for campaign ${id}: daily limit reached`);
            continue;
        }
        activeSessions.push(sid);
    }
    
    const roundRobinSessions = activeSessions.length > 0 ? activeSessions : targetSessions;
    let roundRobinIdx = 0;

    const recipients = db.prepare(`SELECT * FROM recipients WHERE campaignId = ? AND status = 'pending'`).all(id);
    const optouts = db.prepare(`SELECT phone, sessionId FROM optouts WHERE sessionId IN (${targetSessions.map(()=>'?').join(',')})`).all(...targetSessions);
    const optoutMap = new Map();
    for (const o of optouts) {
        if (!optoutMap.has(o.phone)) optoutMap.set(o.phone, new Set());
        optoutMap.get(o.phone).add(o.sessionId);
    }

    const jobsBySession = {};
    const skippedIds = [];
    
    const updateCampaign = db.prepare(`UPDATE campaigns SET status = 'running', startedAt = ? WHERE id = ?`);
    const updateSkipped = db.prepare(`UPDATE recipients SET status = 'skipped', sessionId = ? WHERE id = ?`);
    const updateQueued = db.prepare(`UPDATE recipients SET status = 'queued', sessionId = ? WHERE id = ?`);

    const startTransaction = db.transaction(() => {
        updateCampaign.run(new Date().toISOString(), campaign.id);
        
        for (const r of recipients) {
            const assignedSession = roundRobinSessions[roundRobinIdx % roundRobinSessions.length];
            roundRobinIdx++;
            
            if (optoutMap.has(r.phone) && optoutMap.get(r.phone).has(assignedSession)) {
                skippedIds.push(r.id);
                updateSkipped.run(assignedSession, r.id);
            } else {
                updateQueued.run(assignedSession, r.id);
                if (!jobsBySession[assignedSession]) jobsBySession[assignedSession] = [];
                jobsBySession[assignedSession].push({
                    name: 'campaign_message',
                    data: {
                        campaignId: campaign.id,
                        recipientId: r.id,
                        to: r.phone,
                        text: renderTemplate(campaign.template, r.name)
                    },
                    opts: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } }
                });
            }
        }
    });

    try {
        startTransaction();
        let totalQueued = 0;
        for (const [sid, sJobs] of Object.entries(jobsBySession)) {
            if (sJobs.length > 0) {
                await queueManager.addRawJobsToQueue(sid, sJobs);
                totalQueued += sJobs.length;
            }
        }
        
        if (totalQueued === 0) {
            db.prepare(`UPDATE campaigns SET status = 'completed', finishedAt = ? WHERE id = ?`).run(new Date().toISOString(), campaign.id);
        }
        res.json({ success: true, queued: totalQueued, skipped: skippedIds.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /campaigns/:id/pause, /resume, /cancel
router.post('/:id/:action', async (req, res) => {
    const { id, action } = req.params;
    if (!['pause', 'resume', 'cancel'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action' });
    }

    const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    
    if (action === 'cancel') {
        try {
            let targetSessions = [];
            try {
                const parsed = JSON.parse(campaign.sessionId);
                if (Array.isArray(parsed)) targetSessions = parsed;
                else targetSessions = [campaign.sessionId];
            } catch(e) {
                targetSessions = [campaign.sessionId];
            }
            
            let canceledCount = 0;
            for (const sid of targetSessions) {
                canceledCount += await queueManager.cancelCampaignJobs(sid, campaign.id);
            }
            
            db.prepare(`UPDATE campaigns SET status = 'canceled', finishedAt = ? WHERE id = ?`).run(new Date().toISOString(), campaign.id);
            res.json({ success: true, canceledJobs: canceledCount });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    } else if (action === 'pause') {
        if (campaign.status !== 'running') {
            return res.status(400).json({ error: 'Only a running campaign can be paused' });
        }
        db.prepare(`UPDATE campaigns SET status = 'paused' WHERE id = ?`).run(campaign.id);
        res.json({ success: true, status: 'paused' });
    } else if (action === 'resume') {
        if (campaign.status !== 'paused') {
            return res.status(400).json({ error: 'Only a paused campaign can be resumed' });
        }
        db.prepare(`UPDATE campaigns SET status = 'running' WHERE id = ?`).run(campaign.id);
        res.json({ success: true, status: 'running' });
    }
});

// GET /campaigns
router.get('/', (req, res) => {
    const rows = db.prepare(`
        SELECT c.*, 
        COUNT(r.id) as totalRecipients,
        SUM(CASE WHEN r.status = 'sent' THEN 1 ELSE 0 END) as sentRecipients
        FROM campaigns c
        LEFT JOIN recipients r ON c.id = r.campaignId
        GROUP BY c.id
        ORDER BY c.id DESC
    `).all();
    
    rows.forEach(row => {
        try {
            row.sessionId = JSON.parse(row.sessionId);
        } catch(e) {}
    });
    
    res.json(rows);
});

// GET /campaigns/:id
router.get('/:id', (req, res) => {
    const { id } = req.params;
    const campaign = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const counts = db.prepare(`
        SELECT status, COUNT(*) as count 
        FROM recipients 
        WHERE campaignId = ? 
        GROUP BY status
    `).all(id);

    const stats = { pending: 0, queued: 0, sent: 0, failed: 0, skipped: 0 };
    counts.forEach(c => stats[c.status] = c.count);

    const sessionCounts = db.prepare(`
        SELECT sessionId, status, COUNT(*) as count
        FROM recipients
        WHERE campaignId = ? AND sessionId IS NOT NULL
        GROUP BY sessionId, status
    `).all(id);
    
    let targetSessions = [];
    try {
        const parsed = JSON.parse(campaign.sessionId);
        if (Array.isArray(parsed)) targetSessions = parsed;
        else targetSessions = [campaign.sessionId];
        campaign.sessionId = parsed;
    } catch(e) {
        targetSessions = [campaign.sessionId];
    }
    
    const sessionStats = {};
    for (const sid of targetSessions) {
        sessionStats[sid] = { pending: 0, queued: 0, sent: 0, failed: 0, skipped: 0 };
    }
    
    sessionCounts.forEach(c => {
        if (!sessionStats[c.sessionId]) sessionStats[c.sessionId] = { pending: 0, queued: 0, sent: 0, failed: 0, skipped: 0 };
        sessionStats[c.sessionId][c.status] = c.count;
    });

    res.json({ ...campaign, stats, sessionStats });
});

// GET /campaigns/:id/recipients
router.get('/:id/recipients', (req, res) => {
    const { id } = req.params;
    const status = req.query.status;
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const offset = (page - 1) * limit;

    let query = `SELECT * FROM recipients WHERE campaignId = ?`;
    const params = [id];

    if (status) {
        query += ` AND status = ?`;
        params.push(status);
    }

    query += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = db.prepare(query).all(...params);
    res.json(rows);
});

module.exports = router;
