import type { NextApiRequest, NextApiResponse } from 'next';

const BAYSE_BASE = 'https://relay.bayse.markets/v1';
const BAYSE_SERIES_SLUG = 'crypto-btc-15min';
const BOT_API_BASE = process.env.NEXT_PUBLIC_BOT_API_URL ?? '';
const ROUND_MS = 15 * 60 * 1000;

interface BayseMarketRaw {
  id: string;
  outcome1Id?: string;
  outcome2Id?: string;
  outcome1Price?: number;
  outcome2Price?: number;
  yesBuyPrice?: number;
  noBuyPrice?: number;
  marketThreshold?: number;
}

interface BayseEventRaw {
  id: string;
  slug: string;
  title?: string;
  closingDate: string;
  openingDate?: string;
  createdAt?: string;
  status?: string;
  eventThreshold?: number;
  eventCloseValue?: number;
  markets?: BayseMarketRaw[];
}

interface BayseEventsResponse {
  events?: BayseEventRaw[];
}

interface TradeStateResponse {
  gameCode: string;
  roundNumber: number;
  arenaEndAt: string;
  virtualBalance: number;
  virtualStartBalance: number;
  place: number;
  memberCount: number;
  prizeIfEndedNow: number;
  tradeWindowOpen: boolean;
  lockedDirection: 'UP' | 'DOWN' | null;
  lockedAmount: number | null;
  ref: string;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseProbability(value: unknown): number | null {
  const parsed = parseNumber(value);
  if (parsed === null || parsed <= 0 || parsed > 1) {
    return null;
  }

  return parsed;
}

function deriveOpeningDate(event: BayseEventRaw): string {
  if (typeof event.openingDate === 'string' && event.openingDate.trim()) {
    return event.openingDate;
  }

  const closingMs = Date.parse(event.closingDate);
  if (Number.isFinite(closingMs)) {
    return new Date(closingMs - ROUND_MS).toISOString();
  }

  if (typeof event.createdAt === 'string' && event.createdAt.trim()) {
    return event.createdAt;
  }

  return new Date().toISOString();
}

function computePctElapsed(openingDate: string, closingDate: string, now: number): number {
  const openingMs = Date.parse(openingDate);
  const closingMs = Date.parse(closingDate);
  const span = closingMs - openingMs;

  if (!Number.isFinite(openingMs) || !Number.isFinite(closingMs) || span <= 0) {
    return 1;
  }

  return Math.min(Math.max((now - openingMs) / span, 0), 1);
}

function buildMarketUrl(marketId: string | null): string | null {
  return marketId ? `https://app.bayse.markets/market/${marketId}` : null;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function getCurrentBtcPrice(): Promise<number | null> {
  try {
    const payload = await fetchJson<{ bitcoin?: { usd?: number } }>(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
    );

    return parseNumber(payload.bitcoin?.usd) ?? null;
  } catch {
    return null;
  }
}

async function getArenaOverlay(tgId: string | null, code: string | null) {
  if (!code) {
    return { arena: null, arenaError: null as string | null };
  }

  if (!tgId) {
    return {
      arena: null,
      arenaError: 'Open this market from the Telegram bot to load your arena.',
    };
  }

  if (!BOT_API_BASE) {
    return { arena: null, arenaError: null as string | null };
  }

  try {
    const tradeState = await fetchJson<TradeStateResponse>(
      `${BOT_API_BASE}/api/trade-state?tgId=${encodeURIComponent(tgId)}&code=${encodeURIComponent(code)}`
    );

    return {
      arena: tradeState,
      arenaError: null as string | null,
    };
  } catch (error) {
    return {
      arena: null,
      arenaError: error instanceof Error ? error.message : 'Failed to load arena.',
    };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const tgId = typeof req.query.tgId === 'string' ? req.query.tgId : null;
  const code =
    typeof req.query.code === 'string' && req.query.code.trim()
      ? req.query.code.trim().toUpperCase()
      : null;

  try {
    const [openPayload, resolvedPayload, currentPrice, overlay] = await Promise.all([
      fetchJson<BayseEventsResponse>(
        `${BAYSE_BASE}/pm/events?seriesSlug=${BAYSE_SERIES_SLUG}&page=1&limit=1&status=open`
      ),
      fetchJson<BayseEventsResponse>(
        `${BAYSE_BASE}/pm/events?seriesSlug=${BAYSE_SERIES_SLUG}&page=1&size=5&limit=5&status=resolved`
      ),
      getCurrentBtcPrice(),
      getArenaOverlay(tgId, code),
    ]);

    const currentEvent = openPayload.events?.[0];
    if (!currentEvent) {
      res.status(502).json({ error: 'No live Bayse BTC round is available right now.' });
      return;
    }

    const now = Date.now();
    const currentMarket = currentEvent.markets?.[0] ?? null;
    const openingDate = deriveOpeningDate(currentEvent);
    const pctElapsed = computePctElapsed(openingDate, currentEvent.closingDate, now);
    const currentRound = {
      eventId: currentEvent.id,
      slug: currentEvent.slug,
      openingDate,
      closingDate: currentEvent.closingDate,
      eventThreshold: parseNumber(currentEvent.eventThreshold),
      pctElapsed,
      status: 'live' as const,
      upPrice: parseProbability(
        currentMarket?.outcome1Price ?? currentMarket?.yesBuyPrice ?? null
      ),
      downPrice: parseProbability(
        currentMarket?.outcome2Price ?? currentMarket?.noBuyPrice ?? null
      ),
      marketId: currentMarket?.id ?? null,
      marketUrl: buildMarketUrl(currentMarket?.id ?? null),
      pricePoint:
        currentPrice ??
        parseNumber(currentEvent.eventThreshold) ??
        parseNumber(currentEvent.eventCloseValue),
    };

    const resolvedRounds = (resolvedPayload.events ?? []).map((event) => {
      const eventOpeningDate = deriveOpeningDate(event);
      const market = event.markets?.[0] ?? null;

      return {
        eventId: event.id,
        slug: event.slug,
        openingDate: eventOpeningDate,
        closingDate: event.closingDate,
        eventThreshold: parseNumber(event.eventThreshold),
        pctElapsed: 1,
        status: 'closed' as const,
        upPrice: null,
        downPrice: null,
        marketId: market?.id ?? null,
        marketUrl: buildMarketUrl(market?.id ?? null),
        pricePoint:
          parseNumber(event.eventCloseValue) ??
          parseNumber(event.eventThreshold),
      };
    });

    const tradeWindowOpen = pctElapsed < 0.2;

    res.status(200).json({
      market: {
        asset: 'BTC',
        title: currentEvent.title ?? 'Bitcoin Up or Down - 15 minutes?',
        currentPrice:
          currentPrice ??
          parseNumber(currentEvent.eventThreshold) ??
          parseNumber(currentEvent.eventCloseValue),
        currentRoundId: currentEvent.id,
        tradeWindowOpen,
        round: {
          eventId: currentRound.eventId,
          slug: currentRound.slug,
          openingDate: currentRound.openingDate,
          closingDate: currentRound.closingDate,
          eventThreshold: currentRound.eventThreshold,
          pctElapsed: currentRound.pctElapsed,
        },
        pricing: currentMarket
          ? {
              upPrice: currentRound.upPrice ?? 0.5,
              downPrice: currentRound.downPrice ?? 0.5,
              upOutcomeId: currentMarket.outcome1Id ?? null,
              downOutcomeId: currentMarket.outcome2Id ?? null,
              eventThreshold: currentRound.eventThreshold,
              eventId: currentRound.eventId,
              marketId: currentMarket.id,
              url: buildMarketUrl(currentMarket.id),
            }
          : null,
        rounds: [currentRound, ...resolvedRounds],
        marketUrl: buildMarketUrl(currentMarket?.id ?? null),
        updatedAt: new Date().toISOString(),
      },
      arena: overlay.arena,
      arenaError: overlay.arenaError,
      requestedCode: code,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load live Bayse market.';
    res.status(500).json({ error: message });
  }
}
