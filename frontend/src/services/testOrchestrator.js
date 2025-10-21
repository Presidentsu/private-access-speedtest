/**
 * Test Orchestrator Service
 * Manages the complete test lifecycle: discovery, warm-up, ramp, measure, cooldown
 * Coordinates download, upload, and latency tests
 */

import apiService from './api.js';
import { MetricsCalculator } from './metricsCalculator.js';

// Test phases and their default durations (ms)
// Reduced durations to limit data transfer to ~300MB total
const PHASES = {
  DISCOVERY: { name: 'discovery', duration: 1000 },
  WARMUP: { name: 'warmup', duration: 2000 },    // Reduced from 3s
  RAMP: { name: 'ramp', duration: 2000 },         // Reduced from 4s
  MEASURE: { name: 'measure', duration: 5000 },   // Reduced from 15s (runs for DL + UL = 10s total)
  COOLDOWN: { name: 'cooldown', duration: 1000 },
};

const DEFAULT_CONCURRENCY = 6;  // 6 streams × 25MB = 150MB per direction
const MIN_CONCURRENCY = 4;
const MAX_CONCURRENCY = 12;
const SAMPLE_INTERVAL = 250; // ms
const ECHO_INTERVAL = 250; // ms
const ECHO_TIMEOUT = 1000; // ms

export class TestOrchestrator {
  constructor() {
    this.callbacks = {}; // Initialize callbacks once, never reset
    this.reset();
  }

  reset() {
    this.phase = null;
    this.abortController = null;
    this.metrics = new MetricsCalculator();
    // DON'T reset callbacks - they're registered once by the UI
    // this.callbacks = {};
    this.capabilities = null;
    this.concurrency = DEFAULT_CONCURRENCY;
    this.activeStreams = [];
    this.ws = null;
    this.echoTimer = null;
    this.echoSeq = 0;
    this.pendingEchoes = new Map();
    this.startTime = null;
  }

  /**
   * Register callbacks for test events
   * @param {Object} callbacks - Event callbacks
   */
  on(event, callback) {
    this.callbacks[event] = callback;
  }

  emit(event, data) {
    console.log(`[TestOrchestrator] Emitting event: ${event}`, data ? Object.keys(data) : 'no data');
    if (this.callbacks[event]) {
      this.callbacks[event](data);
    } else {
      console.warn(`[TestOrchestrator] No callback registered for event: ${event}`);
    }
  }

  /**
   * Start a speed test
   * @param {Object} options - Test options
   */
  async start(options = {}) {
    this.reset();
    this.abortController = new AbortController();
    this.startTime = Date.now();

    const testDuration = options.duration || PHASES.MEASURE.duration;

    try {
      // Phase 1: Discovery
      await this.runDiscovery();

      // Start WebSocket for latency testing
      await this.startLatencyTest();

      // Phase 2: Warm-up
      await this.runWarmup();

      // Phase 3: Ramp
      await this.runRamp();

      // Phase 4: Measure (Download test)
      await this.runMeasure('download', testDuration);

      // Phase 5: Measure (Upload test)
      await this.runMeasure('upload', testDuration);

      // Phase 6: Cooldown
      await this.runCooldown();

      // Complete
      this.emit('complete', this.metrics.getMetrics());

    } catch (error) {
      if (error.name === 'AbortError') {
        this.emit('cancelled', { reason: 'User cancelled' });
      } else {
        this.emit('error', { error: error.message });
      }
    } finally {
      this.cleanup();
    }
  }

  /**
   * Stop the current test
   */
  stop() {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.cleanup();
  }

  /**
   * Phase 1: Discovery - Get server capabilities
   */
  async runDiscovery() {
    this.phase = PHASES.DISCOVERY.name;
    this.emit('phaseChange', { phase: this.phase });

    try {
      this.capabilities = await apiService.getCapabilities();
      this.concurrency = Math.min(this.capabilities.maxConcurrency || DEFAULT_CONCURRENCY, MAX_CONCURRENCY);

      this.emit('capabilities', this.capabilities);
    } catch (error) {
      throw new Error(`Discovery failed: ${error.message}`);
    }
  }

  /**
   * Start WebSocket latency testing
   */
  async startLatencyTest() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = apiService.createWebSocket();
        console.log('WebSocket connecting to:', this.ws.url);

        this.ws.onopen = () => {
          console.log('✅ WebSocket connected successfully');
          this.startEchoLoop();
          resolve();
        };

        this.ws.onerror = (error) => {
          console.error('❌ WebSocket error:', error);
          console.error('WebSocket URL:', this.ws?.url);
          console.error('WebSocket state:', this.ws?.readyState);
          reject(new Error('WebSocket connection failed. Check that backend is running on port 3000.'));
        };

        this.ws.onmessage = (event) => {
          this.handleEchoResponse(event.data);
        };

        this.ws.onclose = (event) => {
          console.log('WebSocket closed. Code:', event.code, 'Reason:', event.reason);
          if (this.echoTimer) {
            clearInterval(this.echoTimer);
          }
        };

        // Timeout if connection takes too long
        setTimeout(() => {
          if (this.ws.readyState !== WebSocket.OPEN) {
            console.error('❌ WebSocket timeout. State:', this.ws?.readyState, 'URL:', this.ws?.url);
            reject(new Error('WebSocket connection timeout. Is the backend running?'));
          }
        }, 5000);
      } catch (error) {
        console.error('❌ Error creating WebSocket:', error);
        reject(error);
      }
    });
  }

  /**
   * Start sending periodic echo messages
   */
  startEchoLoop() {
    this.echoTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendEcho();
      }
    }, ECHO_INTERVAL);
  }

  /**
   * Send an echo message
   */
  sendEcho() {
    const seq = this.echoSeq++;
    const timestamp = Date.now();

    const message = JSON.stringify({ seq, timestamp });
    this.ws.send(message);

    // Set timeout for this echo
    const timeoutId = setTimeout(() => {
      if (this.pendingEchoes.has(seq)) {
        this.pendingEchoes.delete(seq);
        this.metrics.addLostEcho();
        this.emit('metricsUpdate', this.metrics.getMetrics());
      }
    }, ECHO_TIMEOUT);

    this.pendingEchoes.set(seq, { timestamp, timeoutId });
  }

  /**
   * Handle echo response
   */
  async handleEchoResponse(data) {
    try {
      let textData = data;

      // Handle Blob data (convert to text)
      if (data instanceof Blob) {
        textData = await data.text();
      }

      const { seq, timestamp: sendTime } = JSON.parse(textData);
      const receiveTime = Date.now();

      if (this.pendingEchoes.has(seq)) {
        const { timeoutId } = this.pendingEchoes.get(seq);
        clearTimeout(timeoutId);
        this.pendingEchoes.delete(seq);

        const rtt = receiveTime - sendTime;
        this.metrics.addRttSample(rtt, receiveTime);

        this.emit('metricsUpdate', this.metrics.getMetrics());
      }
    } catch (error) {
      console.error('Error parsing echo response:', error);
    }
  }

  /**
   * Phase 2: Warm-up
   */
  async runWarmup() {
    this.phase = PHASES.WARMUP.name;
    this.emit('phaseChange', { phase: this.phase });

    // Start with fewer streams, gradually increase
    const initialStreams = Math.max(2, Math.floor(this.concurrency / 2));

    await this.runDownloadStreams(initialStreams, PHASES.WARMUP.duration, true);
  }

  /**
   * Phase 3: Ramp
   */
  async runRamp() {
    this.phase = PHASES.RAMP.name;
    this.emit('phaseChange', { phase: this.phase });

    // Ramp up to full concurrency
    await this.runDownloadStreams(this.concurrency, PHASES.RAMP.duration, false);
  }

  /**
   * Phase 4: Measure
   */
  async runMeasure(direction, duration) {
    this.phase = `${PHASES.MEASURE.name}-${direction}`;
    this.emit('phaseChange', { phase: this.phase });

    if (direction === 'download') {
      await this.runDownloadStreams(this.concurrency, duration, false);
    } else if (direction === 'upload') {
      await this.runUploadStreams(this.concurrency, duration);
    }
  }

  /**
   * Phase 5: Cooldown
   */
  async runCooldown() {
    this.phase = PHASES.COOLDOWN.name;
    this.emit('phaseChange', { phase: this.phase });

    await this.sleep(PHASES.COOLDOWN.duration);
  }

  /**
   * Run parallel download streams
   */
  async runDownloadStreams(numStreams, duration, isWarmup) {
    const durationSec = Math.ceil(duration / 1000);
    const promises = [];

    for (let i = 0; i < numStreams; i++) {
      promises.push(this.runSingleDownloadStream(i, durationSec, isWarmup));
    }

    await Promise.all(promises);
  }

  /**
   * Run a single download stream
   */
  async runSingleDownloadStream(streamId, durationSec, isWarmup) {
    try {
      const response = await apiService.createDownloadStream(
        durationSec,
        streamId,
        this.abortController.signal
      );

      if (!response.ok) {
        throw new Error(`Download stream ${streamId} failed: ${response.statusText}`);
      }

      const reader = response.body.getReader();
      let totalBytes = 0;
      let lastSampleTime = Date.now();
      let bucketBytes = 0;

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        totalBytes += value.length;
        bucketBytes += value.length;

        // Sample every 250ms
        const now = Date.now();
        if (now - lastSampleTime >= SAMPLE_INTERVAL) {
          if (!isWarmup) {
            this.metrics.addThroughputSample(bucketBytes, now);
            this.emit('metricsUpdate', this.metrics.getMetrics());
          }

          bucketBytes = 0;
          lastSampleTime = now;
        }
      }

      // Add final bucket
      if (bucketBytes > 0 && !isWarmup) {
        this.metrics.addThroughputSample(bucketBytes, Date.now());
      }

    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(`Download stream ${streamId} error:`, error);
      }
    }
  }

  /**
   * Run parallel upload streams
   */
  async runUploadStreams(numStreams, duration) {
    const promises = [];

    for (let i = 0; i < numStreams; i++) {
      promises.push(this.runSingleUploadStream(i, duration));
    }

    await Promise.all(promises);
  }

  /**
   * Run a single upload stream - SIMPLIFIED VERSION
   */
  async runSingleUploadStream(streamId, duration) {
    try {
      const chunkSize = 64 * 1024; // 64KB chunks
      const startTime = Date.now();
      const endTime = startTime + duration;
      let totalBytes = 0;

      // Send chunks in a loop until duration expires
      while (Date.now() < endTime && (!this.abortController || !this.abortController.signal.aborted)) {
        // Generate random chunk
        const chunk = new Uint8Array(chunkSize);
        crypto.getRandomValues(chunk);

        // Send chunk via simple POST
        const response = await fetch(`${apiService.baseUrl || ''}/upload?streamId=${streamId}`, {
          method: 'POST',
          body: chunk,
          headers: {
            'Content-Type': 'application/octet-stream',
          },
          signal: this.abortController?.signal,
        });

        if (!response.ok) {
          throw new Error(`Upload failed: ${response.statusText}`);
        }

        totalBytes += chunkSize;

        // Track for metrics
        this.metrics.addThroughputSample(chunkSize, Date.now());
        this.emit('metricsUpdate', this.metrics.getMetrics());
      }

      console.log(`Upload stream ${streamId} completed: ${totalBytes} bytes`);

    } catch (error) {
      if (error.name !== 'AbortError') {
        console.error(`Upload stream ${streamId} error:`, error);
      }
    }
  }

  /**
   * Cleanup resources
   */
  cleanup() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    if (this.echoTimer) {
      clearInterval(this.echoTimer);
      this.echoTimer = null;
    }

    // Clear pending echo timeouts
    for (const [, { timeoutId }] of this.pendingEchoes) {
      clearTimeout(timeoutId);
    }
    this.pendingEchoes.clear();

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Helper to sleep for a duration
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current test progress
   */
  getProgress() {
    if (!this.startTime) return 0;

    const elapsed = Date.now() - this.startTime;
    const totalDuration = Object.values(PHASES).reduce((sum, p) => sum + p.duration, 0) + (PHASES.MEASURE.duration); // x2 for DL and UL

    return Math.min(100, (elapsed / totalDuration) * 100);
  }
}

export default new TestOrchestrator();
