import { createHash, createHmac } from "crypto";
import { config } from "./config.ts";

const BASE = "https://relay.bayse.markets/v1";
const NGN_BASE = 100; // ₦100 per share at probability 1.0

// ── HMAC auth ─────────────────────────────────────────────────────────────────

function sign(method: string, path: string, body: string | null): Record<string, string> {
  const pub = config.BAYSE_PUBLIC_KEY;
  const sec = config.BAYSE_SECRET_KEY;
  if (!pub || !sec) throw new Error("BAYSE_PUBLIC_KEY / BAYSE_SECRET_KEY not configured.");

  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = body ? createHash("sha256").update(body).digest("hex") : "";
  const payload = `${ts}.${method}.${path}.${bodyHash}`;
  const sig = createHmac("sha256", sec).update(payload).digest("base64");

  return {
    "X-Public-Key": pub,
    "X-Timestamp": ts,
    "X-Signature": sig,
    "Content-Type": "application/json",
  };
}

async function request<T>(method: string, path: string, body?: object): Promise<T> {
  const bodyStr = body ? JSON.stringify(body) : null;
  const headers = method === "GET"
    ? { "X-Public-Key": config.BAYSE_PUBLIC_KEY ?? "", "Content-Type": "application/json" }
    : sign(method, path, bodyStr);

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: bodyStr ?? undefined,
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bayse ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BayseMarketOutcome {
  id: string;
  label: string;       // "Yes" | "No"
  price: number;       // probability 0–1
}

export interface BayseMarket {
  id: string;
  title: string;
  outcome1Id: string;
  outcome1Label: string;
  outcome1Price: number;
  outcome2Id: string;
  outcome2Label: string;
  outcome2Price: number;
  status: string;
  resolvedOutcome: string;
}

export interface BayseEvent {
  id: string;
  slug: string;
  title: string;
  category: string;
  status: string;
  closingDate: string;
  liquidity: number;
  totalOrders: number;
  engine: string;       // "AMM" | "CLOB"
  type: string;         // "SINGLE_MARKET" | "COMBINED_MARKETS"
  countryCodes: string[] | null;
  markets: BayseMarket[];
}

export interface BayseOrderResult {
  engine: "AMM" | "CLOB";
  order: {
    id: string;
    outcome: string;
    side: string;
    type: string;
    status: string;
    amount: number;
    price: number;
    quantity: number;
    currency: string;
    createdAt: string;
    updatedAt: string;
  };
}

export interface BaysePosition {
  id: string;
  outcome: string;        // "YES" | "NO"
  outcomeId: string;
  balance: number;        // shares held
  averagePrice: number;
  cost: number;
  currentValue: number;
  payoutIfOutcomeWins: number;
  currency: string;
  market: {
    id: string;
    title: string;
    event: {
      id: string;
      title: string;
      type: string;
      engine: string;
    };
  };
  createdAt: string;
  updatedAt: string;
}

// ── List open Nigerian/sports events ─────────────────────────────────────────

export async function listBayseEvents(opts?: {
  category?: string;
  countryCodes?: string;
  size?: number;
}): Promise<BayseEvent[]> {
  const params = new URLSearchParams({
    page: "1",
    size: String(opts?.size ?? 20),
    currency: "NGN",
    status: "open",
  });
  if (opts?.category) params.set("category", opts.category);
  if (opts?.countryCodes) params.set("countryCodes", opts.countryCodes);

  const data = await request<{ events?: BayseEvent[] }>("GET", `/pm/events?${params}`);
  return (data.events ?? []).filter((e) => e.markets?.length > 0);
}

// ── Place aggregated order ────────────────────────────────────────────────────

export async function placeBayseOrder(input: {
  eventId: string;
  marketId: string;
  outcomeId: string;
  amountNgn: number;   // total NGN across all users on this side
}): Promise<BayseOrderResult> {
  const path = `/pm/events/${input.eventId}/markets/${input.marketId}/orders`;
  return request<BayseOrderResult>("POST", path, {
    side: "BUY",
    outcomeId: input.outcomeId,
    amount: input.amountNgn,
    type: "MARKET",
    currency: "NGN",
  });
}

// ── Get portfolio (all positions) ─────────────────────────────────────────────

export async function getBaysePortfolio(): Promise<BaysePosition[]> {
  const data = await request<{ outcomeBalances?: BaysePosition[] }>("GET", "/pm/portfolio");
  return data.outcomeBalances ?? [];
}

// ── Get wallet balance ────────────────────────────────────────────────────────

export async function getBayseWalletBalance(): Promise<{ usd: number; ngn: number }> {
  const data = await request<{ assets?: { symbol: string; availableBalance: number }[] }>(
    "GET", "/wallet/assets"
  );
  const assets = data.assets ?? [];
  return {
    usd: assets.find((a) => a.symbol === "USD")?.availableBalance ?? 0,
    ngn: assets.find((a) => a.symbol === "NGN")?.availableBalance ?? 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert NGN amount to USDC at fixed rate */
export function ngnToUsdc(ngn: number, rate = 1600): number {
  return Math.round((ngn / rate) * 1_000_000) / 1_000_000;
}

/** Shares bought for a given NGN amount at a given probability price */
export function sharesForAmount(amountNgn: number, price: number): number {
  return Math.floor(amountNgn / (price * NGN_BASE));
}

/** Potential payout in NGN if shares win */
export function potentialPayoutNgn(shares: number): number {
  return shares * NGN_BASE;
}
