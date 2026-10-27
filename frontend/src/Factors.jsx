import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function Factors() {
  const [factors, setFactors] = useState(null);
  useEffect(() => { api.factors().then((r) => setFactors(r.factors)); }, []);
  if (!factors) return <p className="muted">Loading…</p>;
  return (
    <table>
      <thead><tr><th>Parameter ID</th><th>Factor</th><th>UOM</th><th>Category</th><th>Source</th></tr></thead>
      <tbody>
        {factors.map((f) => (
          <tr key={f.parameterId}><td>{f.parameterId}</td><td>{f.factor}</td><td>{f.uom}</td><td>{f.category}</td><td>{f.source}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
