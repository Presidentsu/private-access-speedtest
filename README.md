# Private Access Speedtest

A self-hosted speedtest-style web application designed to benchmark **Private Access over SASE** (Secure Access Service Edge) connections, not the public internet. Features a minimalist black-and-white UI and comprehensive connection reliability metrics.

## Features

- **Connection Reliability Testing** over SASE private paths
- **Comprehensive Metrics**:
  - Download/Upload throughput (Mbps)
  - RTT latency with percentiles (p95/p99)
  - Jitter measurement (RFC-3550 estimator)
  - Packet loss percentage
  - Tail latency analysis
  - Stability score (0-100)

- **Multi-Stream Testing**: Adaptive concurrency (4-12 parallel streams)
- **Test Phases**: Discovery → Warm-up → Ramp → Measure → Cooldown
- **WebSocket Latency Testing**: Continuous RTT/jitter monitoring
- **Export Results**: JSON and CSV formats
- **Minimalist Black & White UI**: WCAG AA compliant

## Architecture

```
Client Browser ──► SASE PoP/Portal ──► Private Tunnel ──► Application Server
                                                          ├── Backend (Node.js)
                                                          │   ├── Download endpoint
                                                          │   ├── Upload endpoint
                                                          │   ├── WebSocket echo
                                                          │   └── Metrics (Prometheus)
                                                          └── Frontend (React + Vite)
```

## Tech Stack

- **Backend**: Node.js + Express + WebSockets
- **Frontend**: React + Vite
- **Metrics**: Custom implementation based on Speedtest methodology
- **Deployment**: Docker Compose (single VM)

## Getting Started

### Prerequisites

- Node.js 18+ and npm
- (Optional) Docker and Docker Compose for deployment

### Development Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd "Private App Speedtest"
   ```

2. **Install backend dependencies**
   ```bash
   cd backend
   npm install
   ```

3. **Install frontend dependencies**
   ```bash
   cd ../frontend
   npm install
   ```

4. **Start the backend server**
   ```bash
   cd backend
   npm start
   ```

   The backend will run on `http://localhost:3000`

5. **Start the frontend development server**
   ```bash
   cd frontend
   npm run dev
   ```

   The frontend will run on `http://localhost:5173` (or another port if 5173 is taken)

6. **Open your browser**
   Navigate to `http://localhost:5173` and click "Start Test"

## API Endpoints

### Backend Server (Port 3000)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/caps` | GET | Server capabilities and feature discovery |
| `/download?seconds=15&streamId=1` | GET | Download stream endpoint (non-compressible data) |
| `/upload?streamId=1` | POST | Upload endpoint (chunked data) |
| `/ws-echo` | WS | WebSocket echo service for latency/jitter testing |
| `/metrics` | GET | Prometheus metrics exposition |
| `/healthz` | GET | Health check endpoint |

## Configuration

### Environment Variables

Create a `.env` file in the frontend directory:

```env
VITE_API_URL=http://localhost:3000
```

For production deployment, set this to your server's URL.

### Test Parameters

Default test configuration (can be modified in `testOrchestrator.js`):

- **Warm-up phase**: 3 seconds
- **Ramp phase**: 4 seconds
- **Measure phase**: 15 seconds (download + upload)
- **Default concurrency**: 6 streams
- **Sample interval**: 250ms
- **Echo interval**: 250ms (latency testing)

## Measurement Methodology

### Throughput Calculation

1. Multi-stream parallel downloads/uploads (adaptive 4-12 streams)
2. 250ms sampling buckets with 1-second rolling windows
3. Warm-up phase discarded (first 3 seconds)
4. Result = median of 1s rolling sums
5. P95/P99 percentiles for tail analysis

### Latency & Jitter

- **RTT**: WebSocket echo every 250ms
- **Jitter**: RFC-3550 estimator: `J = J + (|D| - J)/16`
- **Stats**: min/avg/median/p95/p99 reported

### Packet Loss

- Calculated from echo timeouts (>1s considered lost)
- Formula: `(lost_echos / sent_echos) * 100%`

### Stability Score

Based on coefficient of variation and p95 latency:
```
score = clamp(100 - (CV * 100) - f(p95_RTT), 0, 100)
```

## Deployment

### Docker Compose (Recommended)

*Coming soon - Docker Compose configuration in progress*

### Manual Deployment

1. Build the frontend:
   ```bash
   cd frontend
   npm run build
   ```

2. Serve the frontend build from the backend:
   Configure your backend to serve static files from `frontend/dist`

3. Deploy to your VM and configure SASE Private App access

## Project Structure

```
.
├── backend/
│   ├── server.js           # Main Express server
│   ├── package.json
│   └── ...
├── frontend/
│   ├── src/
│   │   ├── components/     # React components
│   │   │   ├── MetricCard.jsx
│   │   │   └── ...
│   │   ├── services/       # Core logic
│   │   │   ├── api.js              # API client
│   │   │   ├── testOrchestrator.js # Test controller
│   │   │   └── metricsCalculator.js # Statistics engine
│   │   ├── App.jsx         # Main app component
│   │   └── ...
│   ├── vite.config.js      # Vite configuration
│   └── package.json
├── requirements.md         # Detailed requirements spec
└── README.md              # This file
```

## Testing

1. **Start both servers** (backend on 3000, frontend on 5173)
2. **Click "Start Test"** in the UI
3. **Monitor phases**:
   - Discovery: Fetching server capabilities
   - Warm-up: Starting streams
   - Ramp: Increasing concurrency
   - Measure (Download): Testing download throughput
   - Measure (Upload): Testing upload throughput
   - Cooldown: Finalizing metrics
4. **Review results** in the metric cards
5. **Export data** as JSON or CSV

## Troubleshooting

### WebSocket Connection Failed

- Ensure backend is running on port 3000
- Check browser console for CORS errors
- Verify Vite proxy configuration in `vite.config.js`

### No Metrics Displayed

- Open browser DevTools → Network tab
- Verify `/caps` endpoint returns successfully
- Check that download/upload streams are receiving data

### High Latency Values

- This is expected when testing over SASE proxy legs
- Values reflect the true SASE path latency (not raw L4)

## Performance Considerations

- **Browser tab throttling**: Test may pause if tab is backgrounded
- **Network conditions**: Results affected by actual SASE path quality
- **Concurrent users**: Backend supports up to 64 concurrent streams (configurable)

## Security

- **HTTPS/WSS**: Strongly recommended for production
- **No PII**: No personal information collected
- **CORS**: Configured for same-origin by default
- **Rate limiting**: Per-IP rate limits enforced

## Observability

### Prometheus Metrics

Access metrics at `http://localhost:3000/metrics`:

- `speedtest_bytes_served_total{direction="download|upload"}` - Total bytes transferred
- `speedtest_active_streams{type="download|upload"}` - Active stream count
- `speedtest_request_duration_seconds{endpoint}` - Request duration histogram
- `speedtest_ws_echo_total` - Total WebSocket echo messages

## Future Enhancements

- [ ] WebRTC data channels for UDP-like testing
- [ ] IndexedDB local history with comparison charts
- [ ] PoP awareness and multi-region testing
- [ ] Server-side scheduled synthetic runs
- [ ] Long-run soak test mode (5-10 minutes)

- Speedtest Methodology: Multi-stream, warm-up, percentile-based calculations

---

**Note**: This application is designed specifically for testing SASE private access connections. For public internet speed testing, use established services like Ookla Speedtest.
