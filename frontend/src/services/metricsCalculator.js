/**
 * Metrics Calculator Service
 * Implements statistical calculations for throughput, latency, jitter, and packet loss
 * According to the requirements specification
 */

export class MetricsCalculator {
  constructor() {
    this.reset();
  }

  reset() {
    // Throughput tracking
    this.throughputSamples = [];
    this.bucketSize = 250; // ms
    this.windowSize = 1000; // ms for rolling window

    // Latency tracking
    this.rttSamples = [];
    this.jitterEstimate = 0;
    this.jitterSamples = [];
    this.lostEchoes = 0;
    this.sentEchoes = 0;
    this.lastRtt = 0;

    // Stability tracking
    this.stabilityScores = [];
  }

  /**
   * Add a throughput sample (bytes received in a time bucket)
   * @param {number} bytes - Bytes transferred
   * @param {number} timestamp - Sample timestamp
   */
  addThroughputSample(bytes, timestamp) {
    this.throughputSamples.push({ bytes, timestamp });
  }

  /**
   * Add an RTT sample
   * @param {number} rtt - Round-trip time in ms
   * @param {number} timestamp - Sample timestamp
   */
  addRttSample(rtt, timestamp) {
    this.sentEchoes++;
    this.rttSamples.push({ rtt, timestamp });

    // Calculate jitter using RFC-3550 estimator
    if (this.lastRtt > 0) {
      const D = Math.abs(rtt - this.lastRtt);
      this.jitterEstimate = this.jitterEstimate + (D - this.jitterEstimate) / 16;
      this.jitterSamples.push(D);
    }

    this.lastRtt = rtt;
  }

  /**
   * Record a lost echo
   */
  addLostEcho() {
    this.sentEchoes++;
    this.lostEchoes++;
  }

  /**
   * Calculate throughput metrics from samples
   * Discards warm-up phase and calculates median/p95/p99
   * @param {number} warmupMs - Warm-up duration to discard (ms)
   * @returns {Object} Throughput metrics
   */
  calculateThroughput(warmupMs = 3000) {
    if (this.throughputSamples.length === 0) {
      return {
        medianMbps: 0,
        p95Mbps: 0,
        p99Mbps: 0,
        avgMbps: 0,
        maxMbps: 0,
      };
    }

    // Sort samples by timestamp
    const sorted = [...this.throughputSamples].sort((a, b) => a.timestamp - b.timestamp);

    // Discard warm-up phase
    const startTime = sorted[0].timestamp + warmupMs;
    const measuredSamples = sorted.filter(s => s.timestamp >= startTime);

    if (measuredSamples.length === 0) {
      return {
        medianMbps: 0,
        p95Mbps: 0,
        p99Mbps: 0,
        avgMbps: 0,
        maxMbps: 0,
      };
    }

    // Calculate 1-second rolling window rates
    const windowRates = [];
    for (let i = 0; i < measuredSamples.length; i++) {
      const windowStart = measuredSamples[i].timestamp;
      const windowEnd = windowStart + this.windowSize;

      let bytesInWindow = 0;
      for (let j = i; j < measuredSamples.length; j++) {
        if (measuredSamples[j].timestamp < windowEnd) {
          bytesInWindow += measuredSamples[j].bytes;
        } else {
          break;
        }
      }

      // Convert to Mbps
      const mbps = (bytesInWindow * 8) / (this.windowSize / 1000) / 1e6;
      windowRates.push(mbps);
    }

    // Calculate statistics
    const sortedRates = [...windowRates].sort((a, b) => a - b);
    const median = this.percentile(sortedRates, 50);
    const p95 = this.percentile(sortedRates, 95);
    const p99 = this.percentile(sortedRates, 99);
    const avg = sortedRates.reduce((sum, r) => sum + r, 0) / sortedRates.length;
    const max = Math.max(...sortedRates);

    return {
      medianMbps: median,
      p95Mbps: p95,
      p99Mbps: p99,
      avgMbps: avg,
      maxMbps: max,
    };
  }

  /**
   * Calculate latency metrics
   * @returns {Object} Latency metrics
   */
  calculateLatency() {
    if (this.rttSamples.length === 0) {
      return {
        minMs: 0,
        avgMs: 0,
        medianMs: 0,
        p95Ms: 0,
        p99Ms: 0,
      };
    }

    const rtts = this.rttSamples.map(s => s.rtt);
    const sortedRtts = [...rtts].sort((a, b) => a - b);

    return {
      minMs: sortedRtts[0],
      avgMs: rtts.reduce((sum, r) => sum + r, 0) / rtts.length,
      medianMs: this.percentile(sortedRtts, 50),
      p95Ms: this.percentile(sortedRtts, 95),
      p99Ms: this.percentile(sortedRtts, 99),
    };
  }

  /**
   * Calculate jitter metrics
   * @returns {Object} Jitter metrics
   */
  calculateJitter() {
    if (this.jitterSamples.length === 0) {
      return {
        meanMs: 0,
        p95Ms: 0,
      };
    }

    const sortedJitter = [...this.jitterSamples].sort((a, b) => a - b);

    return {
      meanMs: this.jitterEstimate,
      p95Ms: this.percentile(sortedJitter, 95),
    };
  }

  /**
   * Calculate packet loss percentage
   * @returns {number} Loss percentage
   */
  calculatePacketLoss() {
    if (this.sentEchoes === 0) return 0;
    return (this.lostEchoes / this.sentEchoes) * 100;
  }

  /**
   * Calculate stability score (0-100)
   * Based on coefficient of variation and p95 latency
   * @param {number} warmupMs - Warm-up duration to discard
   * @returns {number} Stability score
   */
  calculateStability(warmupMs = 3000) {
    const throughput = this.calculateThroughput(warmupMs);
    const latency = this.calculateLatency();

    // Coefficient of variation for throughput
    const cv = throughput.avgMbps > 0
      ? Math.abs(throughput.medianMbps - throughput.avgMbps) / throughput.avgMbps
      : 0;

    // Penalize high p95 latency
    const latencyPenalty = Math.min(latency.p95Ms / 10, 50);

    const score = Math.max(0, Math.min(100, 100 - (cv * 100) - latencyPenalty));

    return Math.round(score);
  }

  /**
   * Calculate percentile of a sorted array
   * @param {number[]} sortedArray - Sorted array of values
   * @param {number} percentile - Percentile to calculate (0-100)
   * @returns {number} Percentile value
   */
  percentile(sortedArray, percentile) {
    if (sortedArray.length === 0) return 0;
    if (sortedArray.length === 1) return sortedArray[0];

    const index = (percentile / 100) * (sortedArray.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;

    return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
  }

  /**
   * Get current metrics snapshot
   * @returns {Object} Current metrics
   */
  getMetrics() {
    return {
      throughput: this.calculateThroughput(),
      latency: this.calculateLatency(),
      jitter: this.calculateJitter(),
      packetLoss: this.calculatePacketLoss(),
      stability: this.calculateStability(),
    };
  }

  /**
   * Export detailed data for JSON/CSV
   * @returns {Object} Detailed metrics data
   */
  exportData() {
    return {
      throughputSamples: this.throughputSamples,
      rttSamples: this.rttSamples,
      jitterSamples: this.jitterSamples,
      sentEchoes: this.sentEchoes,
      lostEchoes: this.lostEchoes,
      metrics: this.getMetrics(),
    };
  }
}

export default new MetricsCalculator();
