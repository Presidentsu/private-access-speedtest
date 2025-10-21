/**
 * SECURE SERVER CONFIGURATION
 * Production-ready server with security hardening
 *
 * Required environment variables:
 * - API_TOKEN: Bearer token for authentication
 * - ALLOWED_ORIGINS: Comma-separated list of allowed CORS origins
 * - NODE_ENV: 'production' or 'development'
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');
const { register, Counter, Gauge, Histogram } = require('prom-client');

const app = express();
const server = http.createServer(app);

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENCY = 32; // Reduced for safety
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB max upload
const MAX_WS_MESSAGE_SIZE = 1024; // 1KB max WebSocket message

// Install security dependencies first:
// npm install helmet express-rate-limit

let helmet, rateLimit;
try {
  helmet = require('helmet');
  rateLimit = require('express-rate-limit');
} catch (e) {
  console.warn('Security dependencies not installed. Run: npm install helmet express-rate-limit');
}

// ===== SECURITY MIDDLEWARE =====

// 1. Security headers
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
    },
  }));
}

// 2. CORS configuration - restrict origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// 3. Rate limiting
let testRateLimiter, generalRateLimiter;
if (rateLimit) {
  testRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, // 20 tests per 15 minutes
    message: { error: 'Too many test requests, please try again later' },
    standardHeaders: true,
  });

  generalRateLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: { error: 'Too many requests' },
  });

  app.use(generalRateLimiter);
}

// 4. Authentication middleware
function authenticate(req, res, next) {
  // Skip auth for health check
  if (req.path === '/healthz') {
    return next();
  }

  // Skip in development if REQUIRE_AUTH is not set
  if (process.env.NODE_ENV !== 'production' && !process.env.REQUIRE_AUTH) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const expectedToken = process.env.API_TOKEN;

  if (!expectedToken) {
    console.warn('API_TOKEN not set! Authentication disabled.');
    return next();
  }

  if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

// 5. Input validation
function validateTestParams(req, res, next) {
  const { seconds, streamId } = req.query;

  if (seconds !== undefined) {
    const sec = parseInt(seconds);
    if (isNaN(sec) || sec < 1 || sec > 120) {
      return res.status(400).json({ error: 'Invalid seconds parameter (1-120)' });
    }
  }

  if (streamId !== undefined) {
    if (!/^[a-zA-Z0-9-]{1,50}$/.test(streamId)) {
      return res.status(400).json({ error: 'Invalid streamId parameter' });
    }
  }

  next();
}

// Apply authentication to all routes except health
app.use(authenticate);

// JSON parsing with size limit
app.use(express.json({ limit: '1mb' }));

// Disable compression and set proper headers
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('X-Powered-By');
  next();
});

// ===== PROMETHEUS METRICS =====
const bytesServedCounter = new Counter({
  name: 'speedtest_bytes_served_total',
  help: 'Total bytes served',
  labelNames: ['direction']
});

const activeStreamsGauge = new Gauge({
  name: 'speedtest_active_streams',
  help: 'Number of active streams',
  labelNames: ['type']
});

const requestDurationHistogram = new Histogram({
  name: 'speedtest_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['endpoint']
});

const wsEchoCounter = new Counter({
  name: 'speedtest_ws_echo_total',
  help: 'Total WebSocket echo messages handled'
});

const securityEventsCounter = new Counter({
  name: 'speedtest_security_events_total',
  help: 'Security events',
  labelNames: ['type']
});

// ===== PRNG =====
class FastPRNG {
  constructor(seed = Date.now()) {
    this.state0 = seed;
    this.state1 = seed * 2 + 1;
  }

  next() {
    let s1 = this.state0;
    const s0 = this.state1;
    this.state0 = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >>> 17;
    s1 ^= s0;
    s1 ^= s0 >>> 26;
    this.state1 = s1;
    return (this.state0 + this.state1) >>> 0;
  }

  fillBuffer(buffer) {
    const view = new Uint32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 4));
    for (let i = 0; i < view.length; i++) {
      view[i] = this.next();
    }
    for (let i = view.length * 4; i < buffer.length; i++) {
      buffer[i] = this.next() & 0xFF;
    }
  }
}

const CHUNK_SIZE = 256 * 1024;
const randomBuffer = Buffer.allocUnsafe(CHUNK_SIZE);
const prng = new FastPRNG();
prng.fillBuffer(randomBuffer);

// ===== CONNECTION TRACKING =====
let activeConnections = 0;
const ipConnections = new Map();

function checkRateLimit(ip) {
  const count = ipConnections.get(ip) || 0;
  return count < MAX_CONCURRENCY;
}

function incrementConnection(ip) {
  activeConnections++;
  ipConnections.set(ip, (ipConnections.get(ip) || 0) + 1);
}

function decrementConnection(ip) {
  activeConnections--;
  const count = ipConnections.get(ip) || 0;
  if (count <= 1) {
    ipConnections.delete(ip);
  } else {
    ipConnections.set(ip, count - 1);
  }
}

// ===== ENDPOINTS =====

// Capabilities endpoint
app.get('/caps', (req, res) => {
  res.json({
    http2: req.httpVersion === '2.0',
    http3: false,
    websocket: true,
    maxConcurrency: 12,
    serverTime: Date.now(),
    chunkSize: CHUNK_SIZE,
    version: '1.0.0',
    securityEnabled: !!process.env.API_TOKEN,
  });
});

// Download endpoint with rate limiting
app.get('/download', testRateLimiter || ((req, res, next) => next()), validateTestParams, (req, res) => {
  const ip = req.ip;

  if (!checkRateLimit(ip)) {
    securityEventsCounter.inc({ type: 'rate_limit_hit' });
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const seconds = Math.min(parseInt(req.query.seconds) || 15, 120);
  const streamId = req.query.streamId || '0';
  const endTime = Date.now() + (seconds * 1000);

  incrementConnection(ip);
  activeStreamsGauge.inc({ type: 'download' });

  const timer = requestDurationHistogram.startTimer({ endpoint: 'download' });

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('X-Stream-Id', streamId);

  let bytesSent = 0;

  const sendChunk = () => {
    if (Date.now() >= endTime || res.writableEnded) {
      if (!res.writableEnded) {
        res.end();
      }
      timer();
      activeStreamsGauge.dec({ type: 'download' });
      decrementConnection(ip);
      bytesServedCounter.inc({ direction: 'download' }, bytesSent);
      return;
    }

    if (Math.random() < 0.1) {
      prng.fillBuffer(randomBuffer);
    }

    const canWrite = res.write(randomBuffer);
    bytesSent += randomBuffer.length;

    if (canWrite) {
      setImmediate(sendChunk);
    } else {
      res.once('drain', sendChunk);
    }
  };

  res.on('close', () => {
    if (!res.writableEnded) {
      timer();
      activeStreamsGauge.dec({ type: 'download' });
      decrementConnection(ip);
      bytesServedCounter.inc({ direction: 'download' }, bytesSent);
    }
  });

  sendChunk();
});

// Upload endpoint with size limit
app.post('/upload', testRateLimiter || ((req, res, next) => next()), validateTestParams, (req, res) => {
  const ip = req.ip;

  if (!checkRateLimit(ip)) {
    securityEventsCounter.inc({ type: 'rate_limit_hit' });
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const streamId = req.query.streamId || '0';
  const startTime = Date.now();

  incrementConnection(ip);
  activeStreamsGauge.inc({ type: 'upload' });

  const timer = requestDurationHistogram.startTimer({ endpoint: 'upload' });

  let receivedBytes = 0;
  const maxSize = MAX_UPLOAD_SIZE;

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;

    // Enforce upload size limit
    if (receivedBytes > maxSize) {
      securityEventsCounter.inc({ type: 'upload_too_large' });
      req.pause();
      res.status(413).json({ error: 'Upload too large' });
      req.connection.destroy();
    }
  });

  req.on('end', () => {
    const durationMs = Date.now() - startTime;

    bytesServedCounter.inc({ direction: 'upload' }, receivedBytes);
    timer();
    activeStreamsGauge.dec({ type: 'upload' });
    decrementConnection(ip);

    res.json({
      receivedBytes,
      durationMs,
      streamId
    });
  });

  req.on('close', () => {
    if (!res.writableEnded) {
      timer();
      activeStreamsGauge.dec({ type: 'upload' });
      decrementConnection(ip);
    }
  });
});

// WebSocket with origin validation and message size limits
const wss = new WebSocket.Server({
  server,
  path: '/ws-echo',
  verifyClient: (info, callback) => {
    const origin = info.origin || info.req.headers.origin;

    // In production, verify origin
    if (process.env.NODE_ENV === 'production' && origin) {
      if (!allowedOrigins.includes(origin)) {
        securityEventsCounter.inc({ type: 'ws_origin_rejected' });
        return callback(false, 403, 'Forbidden origin');
      }
    }

    // Verify authentication
    const authHeader = info.req.headers.authorization;
    const expectedToken = process.env.API_TOKEN;

    if (process.env.NODE_ENV === 'production' && expectedToken) {
      if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
        securityEventsCounter.inc({ type: 'ws_auth_failed' });
        return callback(false, 401, 'Unauthorized');
      }
    }

    callback(true);
  },
});

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  ws.on('message', (data) => {
    // Enforce message size limit
    if (data.length > MAX_WS_MESSAGE_SIZE) {
      securityEventsCounter.inc({ type: 'ws_message_too_large' });
      ws.close(1009, 'Message too large');
      return;
    }

    wsEchoCounter.inc();

    try {
      ws.send(data);
    } catch (err) {
      console.error('WebSocket send error:', err);
    }
  });

  ws.on('ping', (data) => {
    ws.pong(data);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

// Metrics endpoint (optionally restrict access)
app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// Health check (no auth required)
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    activeConnections,
    uptime: process.uptime(),
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`SECURE SASE Speedtest Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Authentication: ${process.env.API_TOKEN ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
