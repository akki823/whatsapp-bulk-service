const { Queue, Worker } = require('bullmq');
const crypto = require('crypto');
const axios = require('axios');
const logger = require('pino')();
const { connection } = require('./redis');
const db = require('../db');

const webhookQueue = new Queue('webhooks', { connection });

const worker = new Worker('webhooks', async (job) => {
    const { event, sessionId, timestamp, data } = job.data;
    
    let url = process.env.WEBHOOK_URL;
    try {
        const row = db.prepare('SELECT url FROM session_webhooks WHERE sessionId = ?').get(sessionId);
        if (row && row.url) {
            url = row.url;
        }
    } catch (err) {
        logger.error(err, 'Failed to get session webhook url');
    }

    if (!url) {
        return { skipped: true, reason: 'No URL configured' };
    }

    const payload = JSON.stringify({ event, sessionId, timestamp, data });
    
    let signature = '';
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
        signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    }

    try {
        await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'x-event': event,
                'x-signature': signature
            },
            timeout: 10000
        });
    } catch (err) {
        throw new Error(`Webhook POST failed: ${err.message}`);
    }
    
    return { success: true };
}, { 
    connection,
    concurrency: 5
});

worker.on('failed', (job, err) => {
    logger.error(`Webhook job ${job?.id} failed: ${err.message}`);
});

function sendWebhook(event, sessionId, data) {
    webhookQueue.add('send_webhook', {
        event,
        sessionId,
        timestamp: new Date().toISOString(),
        data
    }, {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 }
    }).catch(err => {
        logger.error(err, 'Failed to enqueue webhook');
    });
}

module.exports = {
    webhookQueue,
    sendWebhook
};
