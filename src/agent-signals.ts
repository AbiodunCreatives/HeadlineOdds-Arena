/**
 * Market signals for arena bot decision-making.
 * All signals return a value in [-1, +1] where:
 *   +1 = strong UP signal
 *   -1 = strong DOWN signal
 *    0 = neutral
 */

const BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines";
const TIMEOUT_MS = 4_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MarketSignals {
  /** BTC price momentum over last 4 x 15m candles: +1 strong up, -1 strong down */
  momentum: number;
  /** RSI(14) normalised to [-1,+1]: >0.4 = overbought (fade), <-0.4 = oversold (buy) */
  rsi: number;
  /** Odds drift: how much upPrice moved since last round */
  oddsDrift: number;
  /** Composite signal: weighted average */
  composite: number;
}

// ── Klines fetch ──────────────────────────────────────────────────────────────

async function fetchKlines(interval: string, limit: number): Promise<number[]> {
  try {
    const url = new URL(BINANCE_KLINES_URL);
    url.searchParams.set("symbol", "BTCUSDT");
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown[][];
    // close prices (index 4)
    return data.map((c) => parseFloat(String(c[4]))).filter(Number.isFinite);
  } catch {
    return [];
  }
}

// ── Signal: momentum ──────────────────────────────────────────────────────────

/**
 * Simple linear regression slope over last `n` closes, normalised to [-1,+1].
 * Uses 4 x 15m candles = 1 hour lookback.
 */
export async function momentumSignal(): Promise<number> {
  const closes = await fetchKlines("15m", 5);
  if (closes.length < 2) return 0;
  const n = closes.length;
  const first = closes[0]!;
  const last = closes[n - 1]!;
  const pctChange = (last - first) / first; // e.g. 0.003 = +0.3%
  // Clamp to ±1% range → maps to [-1, +1]
  return Math.max(-1, Math.min(1, pctChange / 0.01));
}

// ── Signal: RSI ───────────────────────────────────────────────────────────────

/**
 * RSI(14) on 15m candles, normalised:
 *   RSI > 70 → overbought → negative signal (fade)
 *   RSI < 30 → oversold  → positive signal (buy)
 *   RSI 40–60 → neutral
 */
export async function rsiSignal(): Promise<number> {
  const closes = await fetchKlines("15m", 16); // 15 diffs for RSI(14)
  if (closes.length < 15) return 0;

  const diffs = closes.slice(1).map((c, i) => c - closes[i]!);
  const gains = diffs.map((d) => Math.max(0, d));
  const losses = diffs.map((d) => Math.max(0, -d));
  const avgGain = gains.reduce((s, v) => s + v, 0) / gains.length;
  const avgLoss = losses.reduce((s, v) => s + v, 0) / losses.length;
  if (avgLoss === 0) return -1; // all gains = overbought
  const rs = avgGain / avgLoss;
  const rsi = 100 - 100 / (1 + rs);

  // Map: RSI 70→100 = -1 (overbought), RSI 0→30 = +1 (oversold), 50 = 0
  if (rsi >= 70) return -((rsi - 70) / 30); // 0 to -1
  if (rsi <= 30) return (30 - rsi) / 30;    // 0 to +1
  return -(rsi - 50) / 20;                  // gentle slope around neutral
}

// ── Signal: odds drift ────────────────────────────────────────────────────────

/**
 * If upPrice dropped since last round, smart money moved to DOWN → negative signal.
 * previousUpPrice comes from the prior round's RoundPricing stored in Redis.
 */
export function oddsDriftSignal(currentUpPrice: number, previousUpPrice: number | null): number {
  if (previousUpPrice === null) return 0;
  const drift = currentUpPrice - previousUpPrice; // positive = market moved toward UP
  // Clamp to ±0.1 price movement → maps to [-1, +1]
  return Math.max(-1, Math.min(1, drift / 0.1));
}

// ── Composite ─────────────────────────────────────────────────────────────────

export async function getMarketSignals(
  currentUpPrice: number,
  previousUpPrice: number | null
): Promise<MarketSignals> {
  const [momentum, rsi] = await Promise.all([momentumSignal(), rsiSignal()]);
  const oddsDrift = oddsDriftSignal(currentUpPrice, previousUpPrice);
  // Weighted composite: momentum 40%, rsi 30%, odds drift 30%
  const composite = momentum * 0.4 + rsi * 0.3 + oddsDrift * 0.3;
  return { momentum, rsi, oddsDrift, composite };
}
