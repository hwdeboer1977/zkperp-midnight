// SPDX-License-Identifier: Apache-2.0

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { Action, PricePoint } from "../lib/activity";
import { fmt6 } from "../lib/bytes";

/** The mark: a shield whose inner path is half solid, half hidden. */
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="zk-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b6cff" />
          <stop offset="1" stopColor="#2dd4e6" />
        </linearGradient>
      </defs>
      <path d="M16 2.5 27 6.6v8.2c0 7-4.6 12.2-11 14.7C9.6 27 5 21.8 5 14.8V6.6Z" fill="url(#zk-g)" opacity="0.18" />
      <path d="M16 2.5 27 6.6v8.2c0 7-4.6 12.2-11 14.7C9.6 27 5 21.8 5 14.8V6.6Z" fill="none" stroke="url(#zk-g)" strokeWidth="1.8" />
      <path d="M10.5 19.5 14.5 14l3 3 4.5-6" fill="none" stroke="url(#zk-g)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10.5 19.5 14.5 14" fill="none" stroke="#e7ebf3" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="1.5 2.5" opacity="0.6" />
    </svg>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  meter,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  /** 0–1, drawn as a bar under the value. */
  meter?: { value: number; tone?: "warn" | "bad" };
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="sub">{sub}</div>}
      {meter && (
        <div className={`meter ${meter.tone ?? ""}`}>
          <i style={{ width: `${Math.max(0, Math.min(1, meter.value)) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

const W = 720;
const H = 240;
const PAD = { top: 12, right: 64, bottom: 24, left: 4 };

/**
 * The mark price over its recent `setPrice` calls: a step line, since the
 * price holds until the next update. One series, so no legend; hover shows the
 * price and when it was set.
 */
export function PriceChart({
  points,
  now,
  format = (v) => `$${fmt6(v)}`,
  axisDecimals,
  emptyText = "No prices set yet.",
  noun = "set",
}: {
  points: PricePoint[] | null;
  now: number;
  /** The tooltip's value. */
  format?: (v: bigint) => string;
  /** Decimals on the axis; by default 0 above 1000, else 2. */
  axisDecimals?: number;
  emptyText?: string;
  /** The tooltip's verb: "set 10/8, 7:30". */
  noun?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  const geo = useMemo(() => {
    if (!points || points.length === 0) return null;
    const t0 = points[0].at;
    const t1 = Math.max(now * 1000, points[points.length - 1].at + 1);
    const values = points.map((p) => Number(p.price) / 1e6);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const span = hi - lo || hi * 0.01 || 1;
    lo -= span * 0.15;
    hi += span * 0.15;
    const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.left - PAD.right);
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
    let d = "";
    points.forEach((p, i) => {
      const px = x(p.at);
      const py = y(values[i]);
      d += i === 0 ? `M${px},${py}` : `H${px}V${py}`;
    });
    d += `H${x(t1)}`;
    const ticks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * (i + 0.5)) / 4);
    return { x, y, d, t0, t1, values, ticks };
  }, [points, now]);

  if (!points) return <div className="chart-empty">Reading the history from the chain…</div>;
  if (!geo) return <div className="chart-empty">{emptyText}</div>;

  const onMove = (e: React.PointerEvent) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const t = geo.t0 + ((((e.clientX - box.left) / box.width) * W - PAD.left) / (W - PAD.left - PAD.right)) * (geo.t1 - geo.t0);
    let i = 0;
    while (i + 1 < points.length && points[i + 1].at <= t) i += 1;
    setHover(i);
  };

  const h = hover === null ? null : { p: points[hover], v: geo.values[hover] };
  const hx = h ? geo.x(h.p.at) : 0;
  const hy = h ? geo.y(h.v) : 0;
  return (
    <div className="chart">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Mark price history">
        <g className="grid">
          {geo.ticks.map((v) => (
            <line key={v} x1={PAD.left} x2={W - PAD.right} y1={geo.y(v)} y2={geo.y(v)} />
          ))}
        </g>
        <g className="axis">
          {geo.ticks.map((v) => (
            <text key={v} x={W - PAD.right + 8} y={geo.y(v) + 4}>
              {v.toFixed(axisDecimals ?? (v >= 1000 ? 0 : 2))}
            </text>
          ))}
          <text x={PAD.left} y={H - 4}>
            {new Date(geo.t0).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </text>
          <text x={W - PAD.right} y={H - 4} textAnchor="end">
            now
          </text>
        </g>
        <path className="line" d={geo.d} />
        {h && (
          <>
            <line className="cross" x1={hx} x2={hx} y1={PAD.top} y2={H - PAD.bottom} />
            <circle className="dot" cx={hx} cy={hy} r={4.5} />
          </>
        )}
        <rect x={0} y={0} width={W} height={H} fill="transparent" />
      </svg>
      {h && (
        <div className="tip" style={{ left: `${(hx / W) * 100}%`, top: `${(hy / H) * 100}%` }}>
          <b>{format(h.p.price)}</b>
          <span className="muted">
            {noun} {new Date(h.p.at).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}

const KIND: Record<string, { ico: string; cls: string; label: string; detail?: string }> = {
  openPosition: { ico: "◆", cls: "open", label: "Position opened", detail: "size, side and owner hidden" },
  closePosition: { ico: "✓", cls: "close", label: "Position closed", detail: "which open it was stays hidden" },
  liquidatePosition: { ico: "!", cls: "liq", label: "Position liquidated", detail: "by the keeper" },
  setPrice: { ico: "◷", cls: "price", label: "Oracle price update" },
  addLiquidity: { ico: "+", cls: "", label: "Liquidity added" },
  removeLiquidity: { ico: "−", cls: "", label: "Liquidity removed" },
  depositFees: { ico: "↧", cls: "", label: "Fee epoch paid to LPs" },
  deploy: { ico: "★", cls: "", label: "Contract deployed" },
};

function ago(ms: number, now: number): string {
  const s = Math.max(0, now - Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** The latest public calls on the contract: what anyone can see happen. */
export function ActivityFeed({ actions, now, limit = 9 }: { actions: Action[] | null; now: number; limit?: number }) {
  if (!actions) return <p className="muted">Reading the contract's history…</p>;
  const recent = actions.slice(-limit).reverse();
  if (recent.length === 0) return <p className="muted">Nothing yet.</p>;
  return (
    <ul className="feed">
      {recent.map((a) => {
        const k = KIND[a.entryPoint] ?? { ico: "·", cls: "", label: a.entryPoint };
        return (
          <li key={a.hash} title={`transaction ${a.hash}`}>
            <span className={`ico ${k.cls}`}>{k.ico}</span>
            <span>
              {k.label}
              {k.detail && <small className="muted">{k.detail}</small>}
            </span>
            <time>{ago(a.timestamp, now)} ago</time>
          </li>
        );
      })}
    </ul>
  );
}
