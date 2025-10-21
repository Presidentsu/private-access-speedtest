import { useState, useEffect } from 'react';
import './MetricCard.css';

export default function MetricCard({ label, value, unit, subtitle, loading }) {
  const [displayValue, setDisplayValue] = useState(value);

  useEffect(() => {
    // Smooth transition for value changes
    setDisplayValue(value);
  }, [value]);

  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">
        {loading ? (
          <span className="metric-loading">--</span>
        ) : (
          <>
            <span className="metric-number">
              {typeof displayValue === 'number' ? displayValue.toFixed(2) : displayValue}
            </span>
            {unit && <span className="metric-unit">{unit}</span>}
          </>
        )}
      </div>
      {subtitle && <div className="metric-subtitle">{subtitle}</div>}
    </div>
  );
}
