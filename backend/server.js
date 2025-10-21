const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const crypto = require('crypto');
const { register, Counter, Gauge, Histogram } = require('prom-client');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws-echo' });

// Configuration
const PORT = process.env.PORT || 3000;
const MAX_CONCURRENCY = 64;
const MAX_BYTES_PER_STREAM = 25 * 1024 * 1024; // 25MB per stream (6 streams = 150MB total)

// Prometheus Metrics
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

// Fast PRNG for generating non-compressible data (xorshift128+)
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
    // Fill remaining bytes
    for (let i = view.length * 4; i < buffer.length; i++) {
      buffer[i] = this.next() & 0xFF;
    }
  }
}

// Pre-generate random buffer for reuse (reduces GC pressure)
const CHUNK_SIZE = 256 * 1024; // 256KB chunks
const randomBuffer = Buffer.allocUnsafe(CHUNK_SIZE);
const prng = new FastPRNG();
prng.fillBuffer(randomBuffer);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Disable compression and set proper headers
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.removeHeader('Content-Encoding');
  next();
});

// Rate limiting
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

// 1. Capabilities endpoint
app.get('/caps', (req, res) => {
  res.json({
    http2: req.httpVersion === '2.0',
    http3: false, // Node.js doesn't natively support HTTP/3 yet
    websocket: true,
    maxConcurrency: 12,
    serverTime: Date.now(),
    chunkSize: CHUNK_SIZE,
    version: '1.0.0'
  });
});

// 2. Download endpoint - streams non-compressible random data
app.get('/download', (req, res) => {
  const ip = req.ip;

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const seconds = Math.min(parseInt(req.query.seconds) || 15, 120);
  const streamId = req.query.streamId || '0';
  const endTime = Date.now() + (seconds * 1000);

  incrementConnection(ip);
  activeStreamsGauge.inc({ type: 'download' });

  const timer = requestDurationHistogram.startTimer({ endpoint: 'download' });

  // Set headers for non-compressible streaming
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Encoding', 'identity');
  res.setHeader('X-Stream-Id', streamId);

  let bytesSent = 0;

  const sendChunk = () => {
    // Stop if time limit, byte limit, or connection closed
    if (Date.now() >= endTime || bytesSent >= MAX_BYTES_PER_STREAM || res.writableEnded) {
      if (!res.writableEnded) {
        res.end();
      }
      timer();
      activeStreamsGauge.dec({ type: 'download' });
      decrementConnection(ip);
      bytesServedCounter.inc({ direction: 'download' }, bytesSent);
      return;
    }

    // Regenerate random data periodically to ensure non-compressibility
    if (Math.random() < 0.1) {
      prng.fillBuffer(randomBuffer);
    }

    // Send smaller chunk if approaching limit
    let chunkToSend = randomBuffer;
    if (bytesSent + randomBuffer.length > MAX_BYTES_PER_STREAM) {
      const remaining = MAX_BYTES_PER_STREAM - bytesSent;
      chunkToSend = randomBuffer.slice(0, remaining);
    }

    const canWrite = res.write(chunkToSend);
    bytesSent += chunkToSend.length;

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

// 3. Upload endpoint - receives chunked data and discards it
app.post('/upload', (req, res) => {
  const ip = req.ip;

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const streamId = req.query.streamId || '0';
  const startTime = Date.now();

  incrementConnection(ip);
  activeStreamsGauge.inc({ type: 'upload' });

  const timer = requestDurationHistogram.startTimer({ endpoint: 'upload' });

  let receivedBytes = 0;

  req.on('data', (chunk) => {
    receivedBytes += chunk.length;

    // Stop accepting data if limit exceeded
    if (receivedBytes > MAX_BYTES_PER_STREAM) {
      req.pause();
      req.unpipe();
      // Let the end handler finish up
    }
    // Data is discarded (sent to /dev/null equivalent)
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

// 4. WebSocket echo endpoint for latency/jitter testing
wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;

  ws.on('message', (data) => {
    wsEchoCounter.inc();

    // Echo the message back immediately
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

// 5. Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.send(await register.metrics());
});

// 6. Health check endpoint
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    activeConnections,
    uptime: process.uptime()
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`SASE Speedtest Server running on port ${PORT}`);
  console.log(`- Capabilities: http://localhost:${PORT}/caps`);
  console.log(`- Download: http://localhost:${PORT}/download?seconds=15&streamId=1`);
  console.log(`- Upload: http://localhost:${PORT}/upload?streamId=1`);
  console.log(`- WebSocket Echo: ws://localhost:${PORT}/ws-echo`);
  console.log(`- Metrics: http://localhost:${PORT}/metrics`);
  console.log(`- Health: http://localhost:${PORT}/healthz`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
