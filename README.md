# WhatsApp Service

A standalone Node.js service providing an HTTP API for WhatsApp using `@whiskeysockets/baileys`, `bullmq` for queues, and `better-sqlite3` for campaign management.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

3. Make sure Redis is running (`localhost:6379`).

## Running the Server

Start the server:
```bash
node src/index.js
```
The server runs on `http://localhost:3000`. It automatically restores previously authenticated sessions and their respective queues on startup. SQLite database is created in `./data/service.db`.

---

## Campaigns & Broadcasting (New in Step 4)

Campaigns allow you to queue messages to multiple recipients with built-in template rendering, de-duplication, and opt-out checking.

**Template Rendering:** 
Variables like `{name}` are replaced with the contact's name (fallback: `there`). Spintax like `{Hi|Hello|Hey}` is randomly chosen per message.

### 1. Create a Campaign (Draft)
Creates a campaign with status `draft`. No messages are queued yet. Max 1000 contacts. Duplicates are removed automatically. `consentConfirmed` MUST be exactly `true`.
You can pass a single `sessionId` or an array of `sessionIds` to distribute recipients across multiple accounts.
```bash
# Single session campaign
curl -X POST http://localhost:3000/campaigns \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-super-secret-key" \
  -d "{\"sessionId\": \"test-session\", \"name\": \"Promo 1\", \"template\": \"{Hi|Hello} {name}, this is a test.\", \"consentConfirmed\": true, \"contacts\": [ {\"phone\": \"91XXXXXXXXXX\", \"name\": \"Ravi\"} ]}"

# Multi-session campaign (PowerShell example)
$body = @{
    sessionIds = @("num1", "num2", "num3")
    name = "Promo 2"
    template = "Hello {name}!"
    consentConfirmed = $true
    contacts = @(
        @{ phone = "91XXXXXXXXX1"; name = "A" },
        @{ phone = "91XXXXXXXXX2"; name = "B" }
    )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod -Method Post -Uri http://localhost:3000/campaigns -Headers @{"x-api-key"="my-super-secret-key"} -ContentType "application/json" -Body $body
```

### 2. Start a Campaign
Renders templates, skips opted-out contacts, and pushes the rest into the session's BullMQ queue. Status becomes `running`.
```bash
curl -X POST http://localhost:3000/campaigns/1/start \
  -H "x-api-key: my-super-secret-key"
```

### 3. Pause, Resume, or Cancel a Campaign
`pause` marks the campaign as paused (delaying pending jobs), `resume` marks it as running again. `cancel` permanently removes all *waiting* and *delayed* jobs belonging to this campaign from the queue.
```bash
curl -X POST http://localhost:3000/campaigns/1/pause \
  -H "x-api-key: my-super-secret-key"
```

### 4. List All Campaigns
Returns all campaigns along with total and sent recipient counts.
```bash
curl -X GET http://localhost:3000/campaigns \
  -H "x-api-key: my-super-secret-key"
```

### 5. Get Campaign Details
Returns campaign details plus a breakdown of all recipient statuses (`pending`, `queued`, `sent`, `failed`, `skipped`).
```bash
curl -X GET http://localhost:3000/campaigns/1 \
  -H "x-api-key: my-super-secret-key"
```

### 6. Get Paginated Recipients
Filter by status (optional) and page.
```bash
curl -X GET "http://localhost:3000/campaigns/1/recipients?status=queued&page=1" \
  -H "x-api-key: my-super-secret-key"
```

---

## Warm-up Mode (New in Step 6)

Warm-up mode automatically increases the daily limit for a session over 14 days, which helps avoid bans on new numbers.

### 1. Start Warm-up
```bash
curl -X POST http://localhost:3000/sessions/test-session/warmup/start \
  -H "x-api-key: my-super-secret-key"
```

### 2. Stop Warm-up
```bash
curl -X POST http://localhost:3000/sessions/test-session/warmup/stop \
  -H "x-api-key: my-super-secret-key"
```

### 3. Check Warm-up Status
```bash
curl -X GET http://localhost:3000/sessions/test-session/warmup \
  -H "x-api-key: my-super-secret-key"
```

---

## Opt-Out Management

If any user replies with the exact text `STOP` (case-insensitive), they are automatically added to the opt-outs for that session.

### 1. Manually Add Opt-Out
```bash
curl -X POST http://localhost:3000/optouts \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-super-secret-key" \
  -d "{\"sessionId\": \"test-session\", \"phone\": \"91XXXXXXXXXX\"}"
```

### 2. Remove an Opt-Out
```bash
curl -X DELETE http://localhost:3000/optouts \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-super-secret-key" \
  -d "{\"sessionId\": \"test-session\", \"phone\": \"91XXXXXXXXXX\"}"
```

### 3. List Opt-Outs for Session
```bash
curl -X GET "http://localhost:3000/optouts?sessionId=test-session" \
  -H "x-api-key: my-super-secret-key"
```

---

## Webhooks (New in Step 5)

Webhooks allow your application to receive real-time HTTP POST notifications when events happen in the WhatsApp service. They are sent via a reliable queue with exponential backoff retries.

### Webhook Configuration
Webhooks are configured globally via `.env`:
- `WEBHOOK_URL`: The URL to POST events to.
- `WEBHOOK_SECRET`: A secret key used to generate an HMAC-SHA256 signature for verification.

You can also override the URL per session:
```bash
# Set a custom webhook URL for a session
curl -X PUT http://localhost:3000/sessions/test-session/webhook \
  -H "Content-Type: application/json" \
  -H "x-api-key: my-super-secret-key" \
  -d "{\"url\": \"https://your-app.com/webhook\"}"

# Get the custom webhook URL for a session
curl -X GET http://localhost:3000/sessions/test-session/webhook \
  -H "x-api-key: my-super-secret-key"
```

### Event Payloads
Webhooks are sent as JSON with the following structure:
```json
{
  "event": "message.sent",
  "sessionId": "test-session",
  "timestamp": "2023-10-01T12:00:00.000Z",
  "data": { ... }
}
```

**Events & `data` structure:**
- `message.sent`: `{ "campaignId": 1, "recipientId": 2, "phone": "91XXXXXXXXXX", "messageId": "..." }`
- `message.failed`: `{ "campaignId": 1, "recipientId": 2, "phone": "91XXXXXXXXXX", "error": "timeout" }`
- `message.reply`: `{ "phone": "91XXXXXXXXXX", "name": "Akki", "text": "Hello", "messageId": "...", "isOptOut": false }`
- `session.connected`: `{ "phone": "91XXXXXXXXXX" }`
- `session.disconnected`: `{ "phone": "91XXXXXXXXXX", "reason": 503 }`
- `campaign.completed`: `{ "campaignId": 1, "counts": { "sent": 50, "failed": 2 } }`

### Signature Verification
Every webhook request includes an `x-signature` header containing an HMAC-SHA256 hash of the raw JSON body using your `WEBHOOK_SECRET`, as well as an `x-event` header containing the event name.

**Node.js Example:**
```javascript
const crypto = require('crypto');
const signature = req.headers['x-signature'];
const expected = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(req.rawBody).digest('hex');
if (signature !== expected) throw new Error("Invalid signature");
```

**Python Example:**
```python
import hmac
import hashlib

signature = request.headers.get('x-signature')
expected = hmac.new(WEBHOOK_SECRET.encode(), request.data, hashlib.sha256).hexdigest()
if signature != expected:
    raise ValueError("Invalid signature")
```

*(See previous step documentation for core auth and direct queue endpoints).*
