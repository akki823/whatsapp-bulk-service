const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

const sessions = new Map();
const sessionGuards = new Set();
const reconnectHistory = new Map();
const processedMessages = new Map();
const SESSIONS_DIR = path.join(__dirname, '..', '..', 'sessions');

function isDuplicateMessage(sessionId, msgId) {
    if (!msgId) return false;
    
    let sessionMsgs = processedMessages.get(sessionId);
    if (!sessionMsgs) {
        sessionMsgs = new Map();
        processedMessages.set(sessionId, sessionMsgs);
    }
    
    const now = Date.now();
    const lastProcessed = sessionMsgs.get(msgId);
    
    if (lastProcessed && (now - lastProcessed) < 300000) {
        return true;
    }
    
    sessionMsgs.set(msgId, now);
    
    if (sessionMsgs.size > 200) {
        let oldestKey = null;
        let oldestTime = now;
        for (const [k, v] of sessionMsgs.entries()) {
            if (v < oldestTime) {
                oldestTime = v;
                oldestKey = k;
            }
        }
        if (oldestKey) sessionMsgs.delete(oldestKey);
    }
    
    return false;
}

// Logger for events
const logger = pino({ level: 'info' });
// Logger for Baileys internal
const baileysLogger = pino({ level: 'silent' });

function getSessionData(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;

    let phone = null;
    let name = null;

    if (session.sock && session.sock.user) {
        phone = session.sock.user.id ? session.sock.user.id.split(':')[0] : null;
        name = session.sock.user.name || null;
    }

    return {
        sessionId,
        status: session.status,
        phone,
        name
    };
}

async function startSession(sessionId) {
    if (sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        const data = getSessionData(sessionId);
        if (session.status === 'qr_pending') {
            data.qr = session.qr;
        }
        return data;
    }

    if (sessionGuards.has(sessionId)) {
        logger.info(`Start session already in progress for ${sessionId}, skipping duplicate start`);
        return { sessionId, status: 'initializing', phone: null, name: null };
    }
    sessionGuards.add(sessionId);

    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }

    let state, saveCreds, version;
    try {
        const auth = await useMultiFileAuthState(sessionDir);
        state = auth.state;
        saveCreds = auth.saveCreds;
        const v = await fetchLatestBaileysVersion();
        version = v.version;
    } catch (e) {
        sessionGuards.delete(sessionId);
        throw e;
    }
    
    logger.info(`Session [${sessionId}] - Using WA v${version.join('.')}`);

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: ['Chrome (Windows)', 'Chrome', '1.0.0']
    });

    sessions.set(sessionId, { sock, status: 'initializing', qr: null });
    sessionGuards.delete(sessionId);
    
    const queueManager = require('../queue');
    queueManager.initQueue(sessionId);

    return new Promise((resolve, reject) => {
        let resolved = false;

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            for (const msg of messages) {
                if (!msg.message) continue;
                if (msg.key.fromMe) continue;
                
                const rawJid = msg.key.remoteJid;
                if (!rawJid) continue;
                if (rawJid.endsWith('@g.us') || rawJid === 'status@broadcast') continue;

                if (isDuplicateMessage(sessionId, msg.key.id)) {
                    continue;
                }

                const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
                if (!text) continue;

                let phone = rawJid.split('@')[0];
                let phoneType = 'phone';

                if (rawJid.endsWith('@lid')) {
                    let altJid = msg.key.remoteJidAlt || msg.key.participantAlt;
                    
                    if (!altJid && sock.signalRepository?.getLidMapping) {
                        try {
                            altJid = await sock.signalRepository.getLidMapping(rawJid);
                        } catch (e) {}
                    }
                    if (!altJid && sock.authState?.keys?.get) {
                        try {
                            const mappings = await sock.authState.keys.get('lid-mapping', [rawJid]);
                            if (mappings && mappings[rawJid]) {
                                altJid = mappings[rawJid];
                            }
                        } catch (e) {}
                    }

                    if (altJid && typeof altJid === 'string' && altJid.includes('@')) {
                        phone = altJid.split('@')[0];
                    } else {
                        phoneType = 'lid';
                    }
                }

                const isOptOut = text.trim().toUpperCase() === 'STOP';

                if (isOptOut) {
                    const db = require('../db');
                    try {
                        db.prepare(`INSERT OR IGNORE INTO optouts (phone, sessionId, createdAt) VALUES (?, ?, ?)`).run(phone, sessionId, new Date().toISOString());
                        logger.info(`Opt-out received for ${phone} (${phoneType}) in session ${sessionId}`);
                    } catch(e) {
                        logger.error(e, 'Error processing STOP message');
                    }
                }

                const { sendWebhook } = require('../queue/webhooks');
                sendWebhook('message.reply', sessionId, {
                    phone,
                    phoneType,
                    name: msg.pushName || null,
                    text,
                    messageId: msg.key.id,
                    isOptOut
                });
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            const session = sessions.get(sessionId);
            if (!session) return;
            
            logger.info({ sessionId, connection, lastDisconnect }, 'Connection update');

            if (qr) {
                try {
                    const qrBase64 = await QRCode.toDataURL(qr);
                    const qrTerminal = await QRCode.toString(qr, { type: 'terminal', small: true });
                    
                    console.log(`\nNew QR Code for session [${sessionId}]:`);
                    console.log(qrTerminal);
                    
                    session.qr = qrBase64;
                    session.status = 'qr_pending';
                    
                    if (!resolved) {
                        resolved = true;
                        resolve(getSessionData(sessionId));
                    }
                } catch (err) {
                    if (!resolved) {
                        resolved = true;
                        reject(err);
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = (lastDisconnect.error)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                logger.info(`Connection closed for session ${sessionId}. Status code: ${statusCode}. Reconnecting: ${shouldReconnect}`);
                
                const { sendWebhook } = require('../queue/webhooks');
                sendWebhook('session.disconnected', sessionId, { phone: session.sock?.user?.id ? session.sock.user.id.split(':')[0] : null, reason: statusCode });
                
                if (shouldReconnect) {
                    session.status = 'disconnected';
                    sessions.delete(sessionId);
                    
                    const now = Date.now();
                    let history = reconnectHistory.get(sessionId) || [];
                    history = history.filter(ts => now - ts < 30000);
                    history.push(now);
                    reconnectHistory.set(sessionId, history);

                    if (history.length > 3) {
                        logger.warn(`Reconnect loop detected for session ${sessionId}, backing off for 30s`);
                        setTimeout(() => {
                            startSession(sessionId).catch(console.error);
                        }, 30000);
                    } else {
                        startSession(sessionId).catch(console.error);
                    }
                } else {
                    // Logged out - remove session directory
                    session.status = 'logged_out';
                    try {
                        if (fs.existsSync(sessionDir)) {
                            fs.rmSync(sessionDir, { recursive: true, force: true });
                        }
                    } catch (e) {
                        logger.error(e, `Failed to delete session directory for ${sessionId}`);
                    }
                    sessions.delete(sessionId);
                }
                
                if (!resolved) {
                    resolved = true;
                    resolve(getSessionData(sessionId) || { sessionId, status: 'disconnected', phone: null, name: null });
                }
            } else if (connection === 'open') {
                logger.info(`Session ${sessionId} connected.`);
                session.status = 'connected';
                session.qr = null;

                const { sendWebhook } = require('../queue/webhooks');
                sendWebhook('session.connected', sessionId, { phone: session.sock?.user?.id ? session.sock.user.id.split(':')[0] : null });

                if (!resolved) {
                    resolved = true;
                    resolve(getSessionData(sessionId));
                }
            }
        });
    });
}

async function logoutSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;

    const queueManager = require('../queue');
    queueManager.stopQueue(sessionId);

    try {
        if (session.sock) {
            await session.sock.logout();
        }
    } catch (e) {
        logger.error(e, `Error logging out socket for ${sessionId}`);
    }

    sessions.delete(sessionId);

    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    try {
        if (fs.existsSync(sessionDir)) {
            fs.rmSync(sessionDir, { recursive: true, force: true });
        }
    } catch (e) {
        logger.error(e, `Failed to delete session directory for ${sessionId}`);
    }

    return true;
}

async function reconnectSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
        if (session.status === 'connected' || session.status === 'qr_pending') {
            return getSessionData(sessionId);
        }
        // Force close existing socket just in case
        try {
            session.sock.ws.close();
        } catch (e) {}
        sessions.delete(sessionId);
    }
    
    // Only allow reconnect if credentials exist
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) {
        throw new Error('No saved credentials for this session');
    }

    return await startSession(sessionId);
}

function getAllSessions() {
    const result = [];
    for (const [sessionId, session] of sessions.entries()) {
        result.push(getSessionData(sessionId));
    }
    return result;
}

function getSessionStatus(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return 'disconnected';
    return session.status;
}

function getSessionQr(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    return session.qr;
}

async function sendMessage(sessionId, to, text) {
    const session = sessions.get(sessionId);
    if (!session || session.status !== 'connected') {
        throw new Error('Session not connected');
    }

    const jid = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
    return await session.sock.sendMessage(jid, { text });
}

async function initSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, { recursive: true });
        return;
    }

    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const sessionId = entry.name;
            logger.info(`Restoring session: ${sessionId}`);
            startSession(sessionId).catch(e => logger.error(e, `Failed to restore ${sessionId}`));
            // Wait 1 second before starting the next session
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

module.exports = {
    startSession,
    logoutSession,
    reconnectSession,
    getAllSessions,
    getSessionData,
    getSessionStatus,
    getSessionQr,
    sendMessage,
    initSessions
};
