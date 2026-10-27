let redisClient = null;

try {
  const redis = require("redis");
  if (process.env.REDIS_URL) {
    redisClient = redis.createClient({ url: process.env.REDIS_URL });
    redisClient.on("error", (err) => console.warn("Redis client warning:", err.message));
    redisClient.connect().catch((err) => {
      console.warn("Redis connection failed, continuing with in-memory fallback:", err.message);
      redisClient = null;
    });
  }
} catch (e) {
  // redis package optional
}

// In-memory fallback cache
const memoryCache = new Map();

const cache = {
  get: async (key) => {
    if (redisClient?.isReady) return await redisClient.get(key);
    const item = memoryCache.get(key);
    if (!item) return null;
    if (item.expires && item.expires < Date.now()) {
      memoryCache.delete(key);
      return null;
    }
    return item.value;
  },
  set: async (key, value, options = {}) => {
    if (redisClient?.isReady) return await redisClient.set(key, value, options);
    const expires = options.EX ? Date.now() + options.EX * 1000 : null;
    memoryCache.set(key, { value, expires });
    return "OK";
  },
  del: async (key) => {
    if (redisClient?.isReady) return await redisClient.del(key);
    memoryCache.delete(key);
    return 1;
  },
  client: redisClient,
};

module.exports = cache;
