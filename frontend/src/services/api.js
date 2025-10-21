// API Service for communicating with the backend

// Use relative URLs by default (works with Vite proxy in dev and nginx in production)
// Override with VITE_API_URL environment variable if needed
const API_BASE_URL = import.meta.env.VITE_API_URL || '';

export class ApiService {
  constructor(baseUrl = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  /**
   * Fetch server capabilities
   */
  async getCapabilities() {
    const response = await fetch(`${this.baseUrl}/caps`);
    if (!response.ok) {
      throw new Error(`Failed to fetch capabilities: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Get health status
   */
  async getHealth() {
    const response = await fetch(`${this.baseUrl}/healthz`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Create download stream
   * @param {number} seconds - Duration in seconds
   * @param {number} streamId - Stream identifier
   * @param {AbortSignal} signal - Abort signal for cancellation
   */
  createDownloadStream(seconds, streamId, signal) {
    const url = `${this.baseUrl}/download?seconds=${seconds}&streamId=${streamId}`;
    return fetch(url, { signal });
  }

  /**
   * Create upload stream
   * @param {ReadableStream} body - Upload data stream
   * @param {number} streamId - Stream identifier
   * @param {AbortSignal} signal - Abort signal for cancellation
   */
  // NOTE: This method is no longer used - upload now uses direct fetch in testOrchestrator
  async createUploadStream(body, streamId, signal) {
    const url = `${this.baseUrl}/upload?streamId=${streamId}`;
    const response = await fetch(url, {
      method: 'POST',
      body,
      signal,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Create WebSocket connection for echo testing
   */
  createWebSocket() {
    // Handle relative URLs by constructing absolute WebSocket URL
    let wsUrl;
    if (this.baseUrl && this.baseUrl.startsWith('http')) {
      // If we have an absolute HTTP URL, convert to WS
      wsUrl = this.baseUrl.replace(/^http/, 'ws');
    } else {
      // For relative URLs, construct from current page location
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.host;
      wsUrl = `${protocol}//${host}`;
    }
    return new WebSocket(`${wsUrl}/ws-echo`);
  }
}

export default new ApiService();
