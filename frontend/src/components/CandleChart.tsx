// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle } from "../lib/market";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** A horizontal line on the chart: an order's level, say. */
export interface Level {
  price: number;
  title: string;
  tone: "good" | "bad" | "muted";
  /** A level not yet placed, drawn fainter. */
  draft?: boolean;
}

/**
 * ETH-USD candles from the live market, with the contract's execution price
 * drawn across them as a dashed line, so any gap between the two is visible,
 * and any `levels` (stop losses, take profits) as dotted ones.
 */
export function CandleChart({ candles, oracle, levels = [] }: { candles: Candle[] | null; oracle: number | null; levels?: Level[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const line = useRef<IPriceLine | null>(null);
  const levelLines = useRef<IPriceLine[]>([]);
  const fitted = useRef(false);
  // Read by the price scale, so the execution line and the levels stay in view however far they are from the market.
  const oracleRef = useRef<number | null>(oracle);
  oracleRef.current = oracle;
  const levelsRef = useRef<Level[]>(levels);
  levelsRef.current = levels;

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted"), fontFamily: css("--mono"), fontSize: 11 },
      grid: { vertLines: { color: css("--border") }, horzLines: { color: css("--border") } },
      rightPriceScale: { borderColor: css("--border") },
      timeScale: { borderColor: css("--border"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: css("--good"),
      downColor: css("--bad"),
      wickUpColor: css("--good"),
      wickDownColor: css("--bad"),
      borderVisible: false,
      autoscaleInfoProvider: (original: () => any) => {
        const r = original();
        const extra = [...(oracleRef.current === null ? [] : [oracleRef.current]), ...levelsRef.current.map((l) => l.price)];
        if (!r || extra.length === 0) return r;
        return {
          ...r,
          priceRange: { minValue: Math.min(r.priceRange.minValue, ...extra), maxValue: Math.max(r.priceRange.maxValue, ...extra) },
        };
      },
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = series.current = line.current = null;
      levelLines.current = [];
      fitted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!series.current) return;
    if (!candles) {
      fitted.current = false;
      return;
    }
    series.current.setData(candles.map((k) => ({ ...k, time: k.time as UTCTimestamp })));
    if (!fitted.current && candles.length > 0) {
      chart.current?.timeScale().fitContent();
      fitted.current = true;
    }
  }, [candles]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    if (line.current) s.removePriceLine(line.current);
    line.current =
      oracle === null
        ? null
        : s.createPriceLine({ price: oracle, color: css("--accent"), lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "execution" });
  }, [oracle]);

  const levelKey = levels.map((l) => `${l.price}:${l.title}:${l.tone}:${l.draft ? 1 : 0}`).join("|");
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of levelLines.current) s.removePriceLine(l);
    levelLines.current = levels.map((l) =>
      s.createPriceLine({
        price: l.price,
        color: css(`--${l.tone}`),
        lineWidth: 1,
        lineStyle: l.draft ? LineStyle.SparseDotted : LineStyle.Dotted,
        axisLabelVisible: !l.draft,
        title: l.title,
      })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelKey]);

  return (
    <div className="candles">
      <div ref={box} className="candles-box" />
      {!candles && <div className="candles-wait">Loading ETH-USD market data…</div>}
    </div>
  );
}
