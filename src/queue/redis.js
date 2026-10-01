require('dotenv').config();
const { Redis } = require('ioredis');

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null,
});

module.exports = { connection };
