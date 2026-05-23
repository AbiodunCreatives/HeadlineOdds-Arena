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

function calcMomentum(closes: number[]): number {
  if (closes.length < 2) return 0;
  const first = closes[0]!;
  const last = closes[closes.length - 1]!;
  return Math.max(-1, Math.min(1, (last - first) / first / 0.01));
}

// ── Signal: RSI ───────────────────────────────────────────────────────────────

function calcRsi(closes: number[]): number {
  if (closes.length < 15) return 0;
  const diffs = closes.slice(1).map((c, i) => c - closes[i]!);
  const gains = diffs.map((d) => Math.max(0, d));
  const losses = diffs.map((d) => Math.max(0, -d));
  const avgGain = gains.reduce((s, v) => s + v, 0) / gains.length;
  const avgLoss = losses.reduce((s, v) => s + v, 0) / losses.length;
  if (avgLoss === 0) return -1;
  const rsi = 100 - 100 / (1 + avgGain / avgLoss);
  if (rsi >= 70) return -((rsi - 70) / 30);
  if (rsi <= 30) return (30 - rsi) / 30;
  return -(rsi - 50) / 20;
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
  // Single fetch covers both momentum (needs 5) and RSI (needs 16)
  const closes = await fetchKlines("15m", 16);
  const momentum = calcMomentum(closes);
  const rsi = calcRsi(closes);
  const oddsDrift = oddsDriftSignal(currentUpPrice, previousUpPrice);
  const composite = momentum * 0.4 + rsi * 0.3 + oddsDrift * 0.3;
  return { momentum, rsi, oddsDrift, composite };
}
