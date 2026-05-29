import { createHash, createHmac } from "crypto";
import { config } from "./config.ts";

const BASE = "https://relay.bayse.markets/v1";
const NGN_BASE = 100; // ₦100 per share at probability 1.0

// ── HMAC auth ─────────────────────────────────────────────────────────────────

function sign(method: string, path: string, body: string | null, keys?: { pub: string; sec: string }): Record<string, string> {
  const pub = keys?.pub ?? config.BAYSE_PUBLIC_KEY;
  const sec = keys?.sec ?? config.BAYSE_SECRET_KEY;
  if (!pub || !sec) throw new Error("BAYSE_PUBLIC_KEY / BAYSE_SECRET_KEY not configured.");

  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = body ? createHash("sha256").update(body).digest("hex") : "";
  const signedPath = `/v1${path}`;
  const payload = `${ts}.${method}.${signedPath}.${bodyHash}`;
  const sig = createHmac("sha256", sec).update(payload).digest("base64");

  return {
    "X-Public-Key": pub,
    "X-Timestamp": ts,
    "X-Signature": sig,
    "Content-Type": "application/json",
  };
}

async function request<T>(method: string, path: string, body?: object, keys?: { pub: string; sec: string }): Promise<T> {
  const bodyStr = body ? JSON.stringify(body) : null;
  const pub = keys?.pub ?? config.BAYSE_PUBLIC_KEY;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (method === "GET" && (keys?.pub ?? config.BAYSE_PUBLIC_KEY)) {
    Object.assign(headers, sign(method, path, null, keys));
  } else if (method !== "GET") {
    Object.assign(headers, sign(method, path, bodyStr, keys));
  }

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
  engine?: "AMM" | "CLOB";
  // Bayse returns order fields either nested under `order` or at the top level
  order?: {
    id?: string;
    outcome?: string;
    side?: string;
    type?: string;
    status?: string;
    amount?: number;
    price?: number;
    quantity?: number;
    currency?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  // flat shape (personal API key responses)
  id?: string;
  amount?: number;
  quantity?: number;
  status?: string;
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
  const events = Array.isArray(data.events) ? data.events : [];

  return events
    .filter((e) => Array.isArray(e?.markets) && e.markets.length > 0)
    .map((e) => ({
      ...e,
      category:
        typeof e.category === "string" && e.category.trim().length > 0
          ? e.category
          : "UNKNOWN",
      liquidity: Number.isFinite(e.liquidity) ? e.liquidity : 0,
      markets: (e.markets ?? []).filter((m) => Boolean(m?.id)),
    }));
}

// ── Place aggregated order ────────────────────────────────────────────────────

export async function placeBayseOrder(input: {
  eventId: string;
  marketId: string;
  outcomeId: string;
  amountNgn: number;
  keys?: { pub: string; sec: string };
}): Promise<BayseOrderResult> {
  const path = `/pm/events/${input.eventId}/markets/${input.marketId}/orders`;
  return request<BayseOrderResult>("POST", path, {
    side: "BUY",
    outcomeId: input.outcomeId,
    amount: input.amountNgn,
    type: "MARKET",
    currency: "NGN",
  }, input.keys);
}

// ── Get portfolio (all positions) ─────────────────────────────────────────────

export async function getBaysePortfolio(keys?: { pub: string; sec: string }): Promise<BaysePosition[]> {
  const data = await request<{ outcomeBalances?: BaysePosition[] }>("GET", "/pm/portfolio", undefined, keys);
  return data.outcomeBalances ?? [];
}

// ── Sell (exit) a position ────────────────────────────────────────────────────

export async function sellBaysePosition(input: {
  eventId: string;
  marketId: string;
  outcomeId: string;
  amountNgn: number;
  shares: number;
  keys?: { pub: string; sec: string };
}): Promise<BayseOrderResult> {
  const path = `/pm/events/${input.eventId}/markets/${input.marketId}/orders`;
  return request<BayseOrderResult>("POST", path, {
    side: "SELL",
    outcomeId: input.outcomeId,
    quantity: input.shares,
    amount: input.amountNgn,
    type: "MARKET",
    currency: "NGN",
  }, input.keys);
}

// ── Get wallet balance ────────────────────────────────────────────────────────

export async function getBayseWalletBalance(keys?: { pub: string; sec: string }): Promise<{ usd: number; ngn: number }> {
  const data = await request<{ assets?: { symbol: string; availableBalance: number }[] }>(
    "GET", "/wallet/assets", undefined, keys
  );
  const assets = data.assets ?? [];
  return {
    usd: assets.find((a) => a.symbol === "USD")?.availableBalance ?? 0,
    ngn: assets.find((a) => a.symbol === "NGN")?.availableBalance ?? 0,
  };
}

// ── User account: login + create API key ─────────────────────────────────────

export async function bayseLogin(email: string, password: string): Promise<{
  token: string;
  deviceId: string;
}> {
  const res = await fetch(`${BASE}/user/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bayse login failed: ${text}`);
  }
  const data = await res.json() as { token: string; deviceId: string };
  return { token: data.token, deviceId: data.deviceId };
}

export async function bayseCreateApiKey(token: string, deviceId: string): Promise<{
  publicKey: string;
  secretKey: string;
}> {
  const res = await fetch(`${BASE}/user/me/api-keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-auth-token": token,
      "x-device-id": deviceId,
    },
    body: JSON.stringify({ name: "HeadlineOdds Bot" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bayse key creation failed: ${text}`);
  }
  const data = await res.json() as { publicKey: string; secretKey: string };
  return { publicKey: data.publicKey, secretKey: data.secretKey };
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
