import { useState, useEffect } from 'react';
import './App.css';
import MetricCard from './components/MetricCard';
import testOrchestrator from './services/testOrchestrator';

function App() {
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [metrics, setMetrics] = useState({
    throughput: { medianMbps: 0, p95Mbps: 0, avgMbps: 0 },
    latency: { avgMs: 0, p95Ms: 0 },
    jitter: { meanMs: 0, p95Ms: 0 },
    packetLoss: 0,
    stability: 0,
  });

  useEffect(() => {
    // Set up event listeners for test orchestrator
    testOrchestrator.on('phaseChange', ({ phase }) => {
      setPhase(phase);
    });

    testOrchestrator.on('metricsUpdate', (newMetrics) => {
      setMetrics(newMetrics);
    });

    testOrchestrator.on('complete', (finalMetrics) => {
      setMetrics(finalMetrics);
      setIsRunning(false);
      setPhase('complete');
    });

    testOrchestrator.on('error', ({ error }) => {
      console.error('Test error:', error);
      setIsRunning(false);
      setPhase('error');
      alert(`Test error: ${error}`);
    });

    testOrchestrator.on('cancelled', () => {
      setIsRunning(false);
      setPhase('cancelled');
    });

    return () => {
      testOrchestrator.stop();
    };
  }, []);

  const handleStartTest = async () => {
    setIsRunning(true);
    setPhase('starting');
    await testOrchestrator.start();
  };

  const handleStopTest = () => {
    testOrchestrator.stop();
    setIsRunning(false);
    setPhase('stopped');
  };

  const handleExportJSON = () => {
    const data = testOrchestrator.metrics.exportData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `speedtest-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCSV = () => {
    const data = testOrchestrator.metrics.exportData();

    // Create CSV header
    let csv = 'Metric,Value\n';

    // Add throughput metrics
    csv += `Download Median (Mbps),${data.metrics.throughput.medianMbps.toFixed(2)}\n`;
    csv += `Download P95 (Mbps),${data.metrics.throughput.p95Mbps.toFixed(2)}\n`;
    csv += `Download Avg (Mbps),${data.metrics.throughput.avgMbps.toFixed(2)}\n`;

    // Add latency metrics
    csv += `Latency Avg (ms),${data.metrics.latency.avgMs.toFixed(2)}\n`;
    csv += `Latency P95 (ms),${data.metrics.latency.p95Ms.toFixed(2)}\n`;

    // Add jitter metrics
    csv += `Jitter Mean (ms),${data.metrics.jitter.meanMs.toFixed(2)}\n`;
    csv += `Jitter P95 (ms),${data.metrics.jitter.p95Ms.toFixed(2)}\n`;

    // Add packet loss and stability
    csv += `Packet Loss (%),${data.metrics.packetLoss.toFixed(2)}\n`;
    csv += `Stability Score,${data.metrics.stability}\n`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `speedtest-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getPhaseText = () => {
    const phaseTexts = {
      idle: 'Ready to start',
      starting: 'Initializing...',
      discovery: 'Discovering server capabilities...',
      warmup: 'Warming up...',
      ramp: 'Ramping up streams...',
      'measure-download': 'Measuring download speed...',
      'measure-upload': 'Measuring upload speed...',
      cooldown: 'Finishing up...',
      complete: 'Test complete',
      error: 'Test failed',
      cancelled: 'Test cancelled',
      stopped: 'Test stopped',
    };
    return phaseTexts[phase] || phase;
  };

  return (
    <div className="app">
      <div className="container">
        <header className="app-header">
          <h1 className="app-title">Private Access Speedtest</h1>
          <p className="app-subtitle text-gray">
            SASE Connection Reliability Tester
          </p>
        </header>

        <div className="test-control mt-2xl">
          {!isRunning ? (
            <button className="btn btn-primary btn-lg" onClick={handleStartTest}>
              Start Test
            </button>
          ) : (
            <button className="btn btn-secondary btn-lg" onClick={handleStopTest}>
              Stop Test
            </button>
          )}

          <div className="phase-indicator mt-md text-center">
            <span className={`phase-text ${isRunning ? 'phase-active' : ''}`}>
              {getPhaseText()}
            </span>
          </div>
        </div>

        <div className="metrics-grid mt-2xl">
          <MetricCard
            label="Download"
            value={metrics.throughput.medianMbps}
            unit="Mbps"
            subtitle={`P95: ${metrics.throughput.p95Mbps.toFixed(2)} Mbps`}
            loading={!isRunning && phase === 'idle'}
          />

          <MetricCard
            label="Upload"
            value={metrics.throughput.avgMbps}
            unit="Mbps"
            subtitle={`P95: ${metrics.throughput.p95Mbps.toFixed(2)} Mbps`}
            loading={!isRunning && phase === 'idle'}
          />

          <MetricCard
            label="Latency"
            value={metrics.latency.avgMs}
            unit="ms"
            subtitle={`P95: ${metrics.latency.p95Ms.toFixed(2)} ms`}
            loading={!isRunning && phase === 'idle'}
          />

          <MetricCard
            label="Jitter"
            value={metrics.jitter.meanMs}
            unit="ms"
            subtitle={`P95: ${metrics.jitter.p95Ms.toFixed(2)} ms`}
            loading={!isRunning && phase === 'idle'}
          />

          <MetricCard
            label="Packet Loss"
            value={metrics.packetLoss}
            unit="%"
            loading={!isRunning && phase === 'idle'}
          />

          <MetricCard
            label="Stability"
            value={metrics.stability}
            unit="/100"
            loading={!isRunning && phase === 'idle'}
          />
        </div>

        {phase === 'complete' && (
          <div className="export-section mt-2xl text-center">
            <h3 className="mb-md">Export Results</h3>
            <div className="export-buttons">
              <button className="btn btn-outline" onClick={handleExportJSON}>
                Export JSON
              </button>
              <button className="btn btn-outline" onClick={handleExportCSV}>
                Export CSV
              </button>
            </div>
          </div>
        )}

        <footer className="app-footer mt-2xl text-center text-gray text-small">
          <p>Testing connection reliability over SASE private access</p>
        </footer>
      </div>
    </div>
  );
}

export default App;
