const http = require('http');
const crypto = require('crypto');
require('dotenv').config();

const port = 4000;
const secret = process.env.WEBHOOK_SECRET;

const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        
        req.on('end', () => {
            const event = req.headers['x-event'];
            const signature = req.headers['x-signature'];

            if (secret) {
                const expectedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex');
                if (signature !== expectedSignature) {
                    console.error('Invalid signature');
                    res.writeHead(401);
                    return res.end('Invalid signature');
                }
            }

            try {
                const data = JSON.parse(body);
                console.log(`[Webhook Received] Event: ${event} | Session: ${data.sessionId} | Timestamp: ${data.timestamp}`);
            } catch (err) {
                console.error('Error parsing JSON payload');
            }

            res.writeHead(200);
            res.end('OK');
        });
    } else {
        res.writeHead(404);
        res.end();
    }
});

server.listen(port, () => {
    console.log(`Test Webhook Receiver listening on http://localhost:${port}`);
});
