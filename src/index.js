require('dotenv').config();
const express = require('express');
const pino = require('pino');
const sessionsRouter = require('./routes/sessions');
const apiKeyMiddleware = require('./middleware/apiKey');
const sessionManager = require('./whatsapp/sessionManager');

const app = express();
const logger = pino();

app.use(express.json());

// Apply API Key middleware to all routes
app.use(apiKeyMiddleware);

// Use the routers
app.use('/', sessionsRouter);
const queueRouter = require('./routes/queue');
const campaignsRouter = require('./routes/campaigns');
const optoutsRouter = require('./routes/optouts');

app.use('/queue', queueRouter);
app.use('/campaigns', campaignsRouter);
app.use('/optouts', optoutsRouter);

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
    logger.info(`Server is running on port ${PORT}`);
    logger.info('Initializing saved sessions...');
    await sessionManager.initSessions();
});
