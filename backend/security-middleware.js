/**
 * Security Middleware
 * Add authentication, rate limiting, and security headers
 */

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

// Simple bearer token authentication
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = process.env.API_TOKEN || 'your-secret-token-here';

  // Skip auth in development if desired
  if (process.env.NODE_ENV !== 'production' && !process.env.REQUIRE_AUTH) {
    return next();
  }

  if (!authHeader || authHeader !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// Advanced rate limiting
const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    // Use Redis in production for distributed rate limiting
    // store: new RedisStore({ client: redisClient }),
  });
};

// Different limits for different endpoints
const limiterConfig = {
  strict: createRateLimiter(
    15 * 60 * 1000, // 15 minutes
    10, // 10 requests
    'Too many test requests, please try again later'
  ),
  moderate: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    30, // 30 requests
    'Too many requests'
  ),
  lenient: createRateLimiter(
    1 * 60 * 1000, // 1 minute
    100, // 100 requests
    'Rate limit exceeded'
  ),
};

// Input validation
function validateTestParams(req, res, next) {
  const { seconds, streamId } = req.query;

  // Validate seconds
  if (seconds !== undefined) {
    const sec = parseInt(seconds);
    if (isNaN(sec) || sec < 1 || sec > 120) {
      return res.status(400).json({ error: 'Invalid seconds parameter (1-120)' });
    }
  }

  // Validate streamId
  if (streamId !== undefined) {
    // Only allow alphanumeric and hyphens
    if (!/^[a-zA-Z0-9-]{1,50}$/.test(streamId)) {
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }
  }

  next();
}

// Upload size limit
function createUploadLimiter(maxBytes) {
  return (req, res, next) => {
    let receivedBytes = 0;

    req.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        req.pause();
        res.status(413).json({ error: 'Upload too large' });
        req.connection.destroy();
      }
    });

    next();
  };
}

// Security headers
function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: 'deny',
    },
    noSniff: true,
    xssFilter: true,
  });
}

// WebSocket origin validation
function validateWebSocketOrigin(info, callback) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',');

  // In development, allow all
  if (process.env.NODE_ENV !== 'production') {
    return callback(true);
  }

  const origin = info.origin || info.req.headers.origin;

  if (!origin || !allowedOrigins.includes(origin)) {
    console.warn(`Rejected WebSocket connection from origin: ${origin}`);
    return callback(false, 403, 'Forbidden');
  }

  callback(true);
}

// WebSocket message size limit
function createWebSocketLimiter(maxMessageSize = 1024) {
  return (ws) => {
    ws.on('message', (data) => {
      if (data.length > maxMessageSize) {
        console.warn('WebSocket message too large, closing connection');
        ws.close(1009, 'Message too large');
      }
    });
  };
}

module.exports = {
  authenticate,
  limiterConfig,
  validateTestParams,
  createUploadLimiter,
  securityHeaders,
  validateWebSocketOrigin,
  createWebSocketLimiter,
};
