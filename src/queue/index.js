const { Queue, Worker, QueueEvents } = require('bullmq');
const { connection } = require('./redis');
const pino = require('pino');
const sessionManager = require('../whatsapp/sessionManager');

const logger = pino({ level: 'info' });
const queues = new Map();
const workers = new Map();

const MIN_DELAY = parseInt(process.env.MIN_DELAY_SEC || '8', 10);
const MAX_DELAY = parseInt(process.env.MAX_DELAY_SEC || '25', 10);
const GLOBAL_DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || '30', 10);

const WARMUP_SCHEDULE = [
    { maxDay: 2, limit: 10 },
    { maxDay: 4, limit: 20 },
    { maxDay: 7, limit: 30 },
    { maxDay: 14, limit: 50 },
    { maxDay: Infinity, limit: 80 }
];

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getDailyCounterKey(sessionId) {
    const dateStr = new Date().toISOString().split('T')[0];
    return `whatsapp:daily:${sessionId}:${dateStr}`;
}

async function getDailyCount(sessionId) {
    const counterKey = getDailyCounterKey(sessionId);
    const count = await connection.get(counterKey);
    return count ? parseInt(count, 10) : 0;
}

async function getDailyLimit(sessionId) {
    const db = require('../db');
    const settings = db.prepare('SELECT warmupEnabled, warmupStartedAt FROM session_settings WHERE sessionId = ?').get(sessionId);
    
    let effectiveLimit = await connection.get(`whatsapp:limit:${sessionId}`);
    effectiveLimit = effectiveLimit ? parseInt(effectiveLimit, 10) : GLOBAL_DAILY_LIMIT;

    if (settings && settings.warmupEnabled && settings.warmupStartedAt) {
        const startedAt = new Date(settings.warmupStartedAt);
        const now = new Date();
        const diffTime = Math.abs(now - startedAt);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1;
        
        let warmupLimit = 80;
        for (const tier of WARMUP_SCHEDULE) {
            if (diffDays <= tier.maxDay) {
                warmupLimit = tier.limit;
                break;
            }
        }
        
        if (diffDays >= 15) {
            db.prepare('UPDATE session_settings SET warmupEnabled = 0 WHERE sessionId = ?').run(sessionId);
        } else {
            return warmupLimit;
        }
    }

    return effectiveLimit;
}

async function setDailyLimit(sessionId, limit) {
    await connection.set(`whatsapp:limit:${sessionId}`, limit);
}

function checkCampaignDone(campaignId) {
    try {
        const db = require('../db');
        const counts = db.prepare(`SELECT status, count(*) as c FROM recipients WHERE campaignId = ? GROUP BY status`).all(campaignId);
        const isDone = counts.every(r => r.status === 'sent' || r.status === 'failed' || r.status === 'skipped');
        if (isDone) {
            db.prepare(`UPDATE campaigns SET status = 'completed', finishedAt = ? WHERE id = ?`).run(new Date().toISOString(), campaignId);
            const { sendWebhook } = require('./webhooks');
            const campaign = db.prepare('SELECT sessionId FROM campaigns WHERE id = ?').get(campaignId);
            if (campaign) {
                const stats = {};
                counts.forEach(c => stats[c.status] = c.c);
                sendWebhook('campaign.completed', campaign.sessionId, { campaignId, counts: stats });
            }
        }
    } catch (e) {
        logger.error(e, 'Error checking if campaign is done');
    }
}

function initQueue(sessionId) {
    if (queues.has(sessionId)) return queues.get(sessionId);

    const qName = `wa_queue_${sessionId}`;
    const q = new Queue(qName, { connection });
    
    const worker = new Worker(qName, async (job) => {
        const { to, text } = job.data;
        
        const status = sessionManager.getSessionStatus(sessionId);
        if (status !== 'connected') {
            logger.info(`Session ${sessionId} not connected, delaying job ${job.id}`);
            await job.moveToDelayed(Date.now() + 30000, job.token);
            throw Worker.DelayedError;
        }

        const limit = await getDailyLimit(sessionId);
        const counterKey = getDailyCounterKey(sessionId);
        const count = await connection.get(counterKey);
        const currentCount = count ? parseInt(count, 10) : 0;
        
        if (currentCount >= limit) {
            logger.info(`Session ${sessionId} daily limit reached (${currentCount}/${limit}), delaying job ${job.id}`);
            const now = new Date();
            const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
            const msUntilTomorrow = tomorrow.getTime() - now.getTime();
            await job.moveToDelayed(Date.now() + msUntilTomorrow, job.token);
            throw Worker.DelayedError;
        }

        if (job.data.campaignId) {
            const db = require('../db');
            const camp = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(job.data.campaignId);
            if (camp && camp.status === 'paused') {
                logger.info(`Campaign ${job.data.campaignId} is paused, delaying job ${job.id}`);
                await job.moveToDelayed(Date.now() + 60000, job.token);
                throw Worker.DelayedError;
            }
        }

        try {
            const result = await sessionManager.sendMessage(sessionId, to, text);
            await connection.incr(counterKey);
            await connection.expire(counterKey, 26 * 60 * 60);
            
            const delaySec = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY;
            logger.info({ sessionId, to, result: result?.key?.id, delaySec }, 'Message sent');
            
            if (job.data.campaignId) {
                const db = require('../db');
                db.prepare(`UPDATE recipients SET status = 'sent', sentAt = ? WHERE id = ?`).run(new Date().toISOString(), job.data.recipientId);
                checkCampaignDone(job.data.campaignId);
            }

            const { sendWebhook } = require('./webhooks');
            sendWebhook('message.sent', sessionId, {
                campaignId: job.data.campaignId || null,
                recipientId: job.data.recipientId || null,
                phone: to,
                messageId: result?.key?.id
            });

            await sleep(delaySec * 1000);
            
            return { success: true, messageId: result?.key?.id };
        } catch (err) {
            logger.error({ sessionId, to, err: err.message }, 'Failed to send message');
            throw err;
        }

    }, { 
        connection,
        concurrency: 1
    });

    worker.on('failed', (job, err) => {
        if (err !== Worker.DelayedError && err.message !== 'delayed') {
            logger.error(`Job ${job?.id} failed in queue ${sessionId}: ${err.message}`);
            if (job && job.attemptsMade >= job.opts.attempts) {
                if (job.data.campaignId) {
                    const db = require('../db');
                    db.prepare(`UPDATE recipients SET status = 'failed', error = ? WHERE id = ?`).run(err.message, job.data.recipientId);
                    checkCampaignDone(job.data.campaignId);
                }
                const { sendWebhook } = require('./webhooks');
                sendWebhook('message.failed', sessionId, {
                    campaignId: job.data.campaignId || null,
                    recipientId: job.data.recipientId || null,
                    phone: job.data.to,
                    error: err.message
                });
            }
        }
    });

    queues.set(sessionId, q);
    workers.set(sessionId, worker);
    
    return q;
}

async function addMessagesToQueue(sessionId, messages) {
    const q = initQueue(sessionId);
    
    const jobs = messages.map(m => ({
        name: 'send_message',
        data: m,
        opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 }
        }
    }));
    
    await q.addBulk(jobs);
    return jobs.length;
}

async function addRawJobsToQueue(sessionId, jobs) {
    const q = initQueue(sessionId);
    await q.addBulk(jobs);
    return jobs.length;
}

async function cancelCampaignJobs(sessionId, campaignId) {
    const q = initQueue(sessionId);
    const waiting = await q.getWaiting();
    const delayed = await q.getDelayed();
    
    let canceled = 0;
    const jobs = [...waiting, ...delayed];
    
    for (const job of jobs) {
        if (job.data.campaignId === parseInt(campaignId)) {
            await job.remove();
            canceled++;
        }
    }
    return canceled;
}

async function getQueueStats(sessionId) {
    const q = initQueue(sessionId);
    const [waiting, active, delayed, completed, failed, paused] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getDelayedCount(),
        q.getCompletedCount(),
        q.getFailedCount(),
        q.isPaused()
    ]);
    
    const counterKey = getDailyCounterKey(sessionId);
    const count = await connection.get(counterKey);
    const sentToday = count ? parseInt(count, 10) : 0;
    const dailyLimit = await getDailyLimit(sessionId);

    return {
        waiting, active, delayed, completed, failed, paused,
        sentToday, dailyLimit
    };
}

async function pauseQueue(sessionId) {
    const q = initQueue(sessionId);
    await q.pause();
}

async function resumeQueue(sessionId) {
    const q = initQueue(sessionId);
    await q.resume();
}

async function removeAllWaitingJobs(sessionId) {
    const q = initQueue(sessionId);
    await q.drain(true);
}

function stopQueue(sessionId) {
    const w = workers.get(sessionId);
    const q = queues.get(sessionId);
    if (w) w.close();
    if (q) q.close();
    workers.delete(sessionId);
    queues.delete(sessionId);
}

module.exports = {
    initQueue,
    addMessagesToQueue,
    addRawJobsToQueue,
    cancelCampaignJobs,
    getQueueStats,
    pauseQueue,
    resumeQueue,
    removeAllWaitingJobs,
    setDailyLimit,
    stopQueue,
    getDailyLimit,
    getDailyCount
};
