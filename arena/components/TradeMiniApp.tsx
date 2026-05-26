import Head from 'next/head';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready(): void;
        expand(): void;
        sendData(data: string): void;
        close(): void;
        initDataUnsafe?: { user?: { id: number } };
        HapticFeedback?: {
          impactOccurred(style?: 'light' | 'medium' | 'heavy'): void;
          selectionChanged(): void;
        };
      };
    };
  }
}

interface MarketRound {
  eventId: string;
  slug: string;
  openingDate: string;
  closingDate: string;
  eventThreshold: number | null;
  pctElapsed: number;
  status: 'closed' | 'live' | 'upcoming';
  upPrice: number | null;
  downPrice: number | null;
  marketId: string | null;
  marketUrl: string | null;
}

interface MarketState {
  asset: 'BTC';
  title: string;
  currentPrice: number | null;
  currentRoundId: string | null;
  tradeWindowOpen: boolean;
  round: {
    eventId: string;
    slug: string;
    openingDate: string;
    closingDate: string;
    eventThreshold: number | null;
    pctElapsed: number;
  } | null;
  pricing: {
    upPrice: number;
    downPrice: number;
    upOutcomeId: string | null;
    downOutcomeId: string | null;
    eventThreshold: number | null;
    eventId: string;
    marketId: string;
    url: string;
  } | null;
  rounds: MarketRound[];
  marketUrl: string | null;
  updatedAt: string;
}

interface ArenaState {
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

interface MiniAppState {
  market: MarketState;
  arena: ArenaState | null;
  arenaError: string | null;
  requestedCode: string | null;
}

type TradeDirection = 'UP' | 'DOWN';

const API_BASE = process.env.NEXT_PUBLIC_BOT_API_URL ?? '';
const BOT_URL = 'https://t.me/HOArena_bot';
const TRADE_AMOUNTS = [10, 25, 50, 100];

function fmtMoney(value: number, digits = 2) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPrice(value: number | null) {
  if (value === null || Number.isNaN(value)) return '--';
  return `$${fmtMoney(value)}`;
}

function fmtPct(probability: number | null) {
  if (probability === null) return '--';
  return `${Math.round(probability * 100)}%`;
}

function fmtRoundTime(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function useCountdown(target: string | null) {
  const [ms, setMs] = useState(0);

  useEffect(() => {
    if (!target) {
      setMs(0);
      return;
    }

    const tick = () => setMs(Math.max(0, Date.parse(target) - Date.now()));
    tick();

    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [target]);

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

async function readErrorMessage(response: Response) {
  const text = await response.text();

  if (!text) {
    return `Request failed with ${response.status}.`;
  }

  try {
    const payload = JSON.parse(text) as { error?: string };
    return payload.error ?? text;
  } catch {
    return text;
  }
}

function RoundChanceChart(props: {
  rounds: MarketRound[];
  selectedRoundId: string | null;
  currentRoundId: string | null;
}) {
  const pricedRounds = props.rounds.filter((round) => round.upPrice !== null);

  if (pricedRounds.length < 2) {
    return (
      <div className="trade-chart-empty">
        Waiting for more Bayse round data.
      </div>
    );
  }

  const width = 100;
  const height = 46;
  const paddingX = 4;
  const paddingY = 5;

  const points = pricedRounds.map((round, index) => {
    const span = Math.max(1, pricedRounds.length - 1);
    const x = paddingX + ((width - paddingX * 2) * index) / span;
    const y = height - paddingY - (round.upPrice ?? 0.5) * (height - paddingY * 2);
    return { round, x, y };
  });

  const linePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');
  const areaPath = `${linePath} L ${points[points.length - 1]!.x} ${height - paddingY / 2} L ${points[0]!.x} ${height - paddingY / 2} Z`;
  const selectedPoint =
    points.find((point) => point.round.eventId === props.selectedRoundId) ??
    points[points.length - 1]!;
  const currentPoint =
    points.find((point) => point.round.eventId === props.currentRoundId) ?? null;
  const baselineY = height - paddingY - 0.5 * (height - paddingY * 2);

  return (
    <div className="trade-chart-card" aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`} className="trade-chart-svg" preserveAspectRatio="none">
        <path d={`M ${paddingX} ${baselineY} L ${width - paddingX} ${baselineY}`} className="trade-chart-baseline" />
        <path d={areaPath} className="trade-chart-area" />
        <path d={linePath} className="trade-chart-line" />
        {currentPoint ? (
          <circle cx={currentPoint.x} cy={currentPoint.y} r="1.8" className="trade-chart-current" />
        ) : null}
        <circle cx={selectedPoint.x} cy={selectedPoint.y} r="2.4" className="trade-chart-selected" />
      </svg>

      <div className="trade-chart-labels">
        <span>{fmtRoundTime(pricedRounds[0]!.closingDate)}</span>
        <span>{fmtRoundTime(pricedRounds[pricedRounds.length - 1]!.closingDate)}</span>
      </div>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="trade-shell">
      <div className="trade-loading-panel" aria-busy="true">
        <div className="trade-loading-top">
          <div className="trade-skeleton trade-skeleton-icon" />
          <div className="trade-loading-copy">
            <div className="trade-skeleton trade-skeleton-title" />
            <div className="trade-skeleton trade-skeleton-line" />
          </div>
        </div>
        <div className="trade-skeleton trade-skeleton-metrics" />
        <div className="trade-skeleton trade-skeleton-chart" />
        <div className="trade-skeleton trade-skeleton-rounds" />
        <div className="trade-skeleton trade-skeleton-actions" />
      </div>
    </div>
  );
}

function ErrorScreen(props: { message: string; onRetry: () => void }) {
  return (
    <div className="trade-shell">
      <div className="trade-error-panel">
        <p className="trade-kicker">HeadlineOdds Arena</p>
        <h1>Live market unavailable</h1>
        <p>{props.message}</p>
        <div className="trade-error-actions">
          <button type="button" className="trade-button trade-button-primary" onClick={props.onRetry}>
            Retry
          </button>
          <a href={BOT_URL} target="_blank" rel="noopener noreferrer" className="trade-button trade-button-secondary">
            Open Telegram bot
          </a>
        </div>
      </div>
    </div>
  );
}

export default function TradeMiniApp() {
  const [data, setData] = useState<MiniAppState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [selectedRoundId, setSelectedRoundId] = useState<string | null>(null);
  const [selectedDirection, setSelectedDirection] = useState<TradeDirection | null>(null);
  const [optimisticLock, setOptimisticLock] = useState<{ direction: TradeDirection; amount: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<number | null>(null);
  const dataRef = useRef<MiniAppState | null>(null);
  const selectedRoundIdRef = useRef<string | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    selectedRoundIdRef.current = selectedRoundId;
  }, [selectedRoundId]);

  async function fetchState() {
    if (!API_BASE) {
      setError('Mini app config missing. Set NEXT_PUBLIC_BOT_API_URL before deploy.');
      return;
    }

    if (typeof window === 'undefined') return;

    const tgId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    const code = new URLSearchParams(window.location.search).get('code')?.trim().toUpperCase();
    const url = new URL(`${API_BASE}/api/miniapp-state`);

    if (tgId) {
      url.searchParams.set('tgId', String(tgId));
    }

    if (code) {
      url.searchParams.set('code', code);
    }

    try {
      const response = await fetch(url.toString());
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }

      const next = (await response.json()) as MiniAppState;
      const previousCurrentRoundId = dataRef.current?.market.currentRoundId ?? null;
      const currentSelectedRoundId = selectedRoundIdRef.current;

      setData(next);
      setError(null);
      setRefreshError(null);

      if (!currentSelectedRoundId || !next.market.rounds.some((round) => round.eventId === currentSelectedRoundId)) {
        setSelectedRoundId(next.market.currentRoundId ?? next.market.rounds[0]?.eventId ?? null);
      }

      if (
        previousCurrentRoundId &&
        next.market.currentRoundId &&
        previousCurrentRoundId !== next.market.currentRoundId
      ) {
        setSelectedRoundId(next.market.currentRoundId);
        setSelectedDirection(null);
        setOptimisticLock(null);
      }

      if (next.arena?.lockedDirection) {
        setSelectedDirection(null);
        setOptimisticLock(null);
      }
    } catch (fetchError) {
      const message =
        fetchError instanceof Error ? fetchError.message : 'Failed to load the live market.';

      if (dataRef.current) {
        setRefreshError(message);
        return;
      }

      setError(message);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;

    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();

    void fetchState();
    pollRef.current = window.setInterval(() => {
      void fetchState();
    }, 10000);

    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
      }
    };
  }, []);

  const selectedRound =
    data?.market.rounds.find((round) => round.eventId === selectedRoundId) ??
    data?.market.rounds[0] ??
    null;
  const selectedIsCurrent = Boolean(
    selectedRound &&
      data?.market.currentRoundId &&
      selectedRound.eventId === data.market.currentRoundId
  );
  const displayUpPrice =
    selectedRound?.upPrice ??
    (selectedIsCurrent ? data?.market.pricing?.upPrice ?? null : null);
  const displayDownPrice =
    selectedRound?.downPrice ??
    (selectedIsCurrent ? data?.market.pricing?.downPrice ?? null : null);
  const upPct = displayUpPrice !== null ? Math.round(displayUpPrice * 100) : null;
  const downPct = displayDownPrice !== null ? Math.round(displayDownPrice * 100) : null;
  const targetPrice =
    selectedRound?.eventThreshold ??
    data?.market.pricing?.eventThreshold ??
    data?.market.round?.eventThreshold ??
    null;
  const currentPrice = selectedIsCurrent ? data?.market.currentPrice ?? null : null;
  const countdownTarget =
    selectedRound?.status === 'upcoming'
      ? selectedRound.openingDate
      : selectedRound?.closingDate ?? null;
  const roundCountdown = useCountdown(countdownTarget);
  const arenaCountdown = useCountdown(data?.arena?.arenaEndAt ?? null);
  const effectiveLock = data?.arena?.lockedDirection
    ? {
        direction: data.arena.lockedDirection,
        amount: data.arena.lockedAmount ?? optimisticLock?.amount ?? null,
      }
    : optimisticLock
      ? { direction: optimisticLock.direction, amount: optimisticLock.amount }
      : null;
  const chanceMomentum = upPct === null ? null : upPct - 50;
  const canTradeLiveRound = Boolean(
    data?.arena &&
      selectedRound &&
      selectedIsCurrent &&
      data.market.tradeWindowOpen &&
      data.arena.ref &&
      upPct !== null &&
      downPct !== null
  );
  const selectedMarketUrl =
    selectedRound?.marketUrl ?? data?.market.marketUrl ?? null;
  const returnPct =
    data?.arena
      ? ((data.arena.virtualBalance - data.arena.virtualStartBalance) / data.arena.virtualStartBalance) * 100
      : null;
  const isPreviewMode = !data?.arena && !data?.requestedCode && !data?.arenaError;

  function triggerSelectionFeedback() {
    window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
  }

  function pickDirection(direction: TradeDirection) {
    if (!canTradeLiveRound || effectiveLock) return;
    triggerSelectionFeedback();
    setSelectedDirection(direction);
  }

  async function placeTrade(amount: number) {
    if (!selectedDirection || !data?.arena || !canTradeLiveRound || submitting) return;

    setSubmitting(true);
    try {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
      window.Telegram?.WebApp?.sendData(
        JSON.stringify({
          action: 'trade',
          direction: selectedDirection,
          amount,
          ref: data.arena.ref,
        })
      );
      setOptimisticLock({ direction: selectedDirection, amount });
      setSelectedDirection(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (error) {
    return (
      <>
        <Head>
          <title>HeadlineOdds Arena</title>
          <script src="https://telegram.org/js/telegram-web-app.js" />
        </Head>
        <ErrorScreen message={error} onRetry={() => void fetchState()} />
      </>
    );
  }

  if (!data || !selectedRound) {
    return (
      <>
        <Head>
          <title>HeadlineOdds Arena</title>
          <script src="https://telegram.org/js/telegram-web-app.js" />
        </Head>
        <LoadingScreen />
      </>
    );
  }

  return (
    <>
      <Head>
        <title>{data.market.title}</title>
        <meta name="description" content="Telegram mini app for HeadlineOdds Arena and live Bayse BTC rounds." />
        <meta name="theme-color" content="#f4f7fb" />
        <script src="https://telegram.org/js/telegram-web-app.js" />
      </Head>

      <div className="trade-shell">
        <main className="trade-app">
          <section className="trade-surface">
            <header className="trade-topbar">
              <div className="trade-brand">
                <div className="trade-brand-mark" aria-hidden="true">
                  BTC
                </div>
                <div>
                  <p className="trade-kicker">Live from Bayse market</p>
                  <h1>{data.market.title}</h1>
                </div>
              </div>

              <div className="trade-topbar-actions">
                <button type="button" className="trade-icon-button" onClick={() => void fetchState()} aria-label="Refresh live market">
                  Refresh
                </button>
                {selectedMarketUrl ? (
                  <a
                    href={selectedMarketUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="trade-icon-button"
                  >
                    Bayse
                  </a>
                ) : null}
              </div>
            </header>

            {refreshError ? (
              <div className="trade-inline-banner" role="status">
                {refreshError}
              </div>
            ) : null}

            <div className="trade-market-header">
              <div className="trade-price-meta">
                <div className="trade-price-block">
                  <span className="trade-price-label">Price target</span>
                  <strong>{fmtPrice(targetPrice)}</strong>
                </div>

                <div className="trade-price-block">
                  <span className="trade-price-label">Current price</span>
                  <strong className="trade-current-price">{fmtPrice(currentPrice)}</strong>
                </div>

                <div className={`trade-timer ${selectedRound.status === 'live' ? 'is-live' : ''}`}>
                  {selectedRound.status === 'closed' ? 'Closed' : roundCountdown}
                </div>
              </div>

              <div className="trade-chance-row">
                <div>
                  <div className="trade-chance-value">{fmtPct(displayUpPrice)}</div>
                  <div className="trade-chance-caption">UP chance</div>
                </div>

                <div className="trade-chance-trend">
                  {chanceMomentum === null ? (
                    'Waiting for pricing'
                  ) : chanceMomentum >= 0 ? (
                    `+${chanceMomentum} pts vs. even`
                  ) : (
                    `${chanceMomentum} pts vs. even`
                  )}
                </div>
              </div>

              <RoundChanceChart
                rounds={data.market.rounds}
                selectedRoundId={selectedRound.eventId}
                currentRoundId={data.market.currentRoundId}
              />
            </div>

            <section className="trade-rounds-panel" aria-labelledby="trade-rounds-heading">
              <div className="trade-section-head">
                <div>
                  <p className="trade-section-kicker">Rounds</p>
                  <h2 id="trade-rounds-heading">Live 15-minute ladder</h2>
                </div>
                <span className="trade-updated-at">Updated {fmtRoundTime(data.market.updatedAt)}</span>
              </div>

              <div className="trade-rounds-rail" role="list" aria-label="Available Bayse rounds">
                {data.market.rounds.map((round) => {
                  const isSelected = round.eventId === selectedRound.eventId;

                  return (
                    <button
                      key={round.eventId}
                      type="button"
                      className={`trade-round-chip ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => {
                        triggerSelectionFeedback();
                        setSelectedRoundId(round.eventId);
                        setSelectedDirection(null);
                      }}
                      aria-pressed={isSelected}
                    >
                      <span className={`trade-round-dot trade-round-dot-${round.status}`} aria-hidden="true" />
                      <span>{fmtRoundTime(round.closingDate)}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            {data.arena ? (
              <section className="trade-stats-grid" aria-label="Arena stats">
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Arena</span>
                  <strong>{data.arena.gameCode}</strong>
                  <span className="trade-stat-sub">Round #{data.arena.roundNumber}</span>
                </article>
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Stack</span>
                  <strong>${fmtMoney(data.arena.virtualBalance)}</strong>
                  <span className={`trade-stat-sub ${returnPct !== null && returnPct >= 0 ? 'is-positive' : returnPct !== null ? 'is-negative' : ''}`}>
                    {returnPct === null ? 'Live bankroll' : `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`}
                  </span>
                </article>
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Rank</span>
                  <strong>#{data.arena.place}</strong>
                  <span className="trade-stat-sub">of {data.arena.memberCount}</span>
                </article>
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Prize</span>
                  <strong>${fmtMoney(data.arena.prizeIfEndedNow)}</strong>
                  <span className="trade-stat-sub">Arena ends in {arenaCountdown}</span>
                </article>
              </section>
            ) : (
              <section className="trade-stats-grid" aria-label="Market facts">
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Mode</span>
                  <strong>{isPreviewMode ? 'Preview' : 'Watch'}</strong>
                  <span className="trade-stat-sub">Open a live arena to trade</span>
                </article>
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Window</span>
                  <strong>{data.market.tradeWindowOpen ? 'Open' : 'Closed'}</strong>
                  <span className="trade-stat-sub">Trades lock early in each round</span>
                </article>
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Asset</span>
                  <strong>{data.market.asset}</strong>
                  <span className="trade-stat-sub">15-minute prediction market</span>
                </article>
                <article className="trade-stat-card">
                  <span className="trade-stat-label">Source</span>
                  <strong>Bayse</strong>
                  <span className="trade-stat-sub">Live market probabilities</span>
                </article>
              </section>
            )}
          </section>

          <section className="trade-actions-panel" aria-labelledby="trade-actions-heading">
            <div className="trade-section-head">
              <div>
                <p className="trade-section-kicker">Arena trading</p>
                <h2 id="trade-actions-heading">Trade the live round</h2>
              </div>
              {data.arena ? (
                <span className="trade-arena-badge">{data.arena.gameCode}</span>
              ) : null}
            </div>

            {data.arenaError ? (
              <div className="trade-callout trade-callout-error" role="alert">
                {data.arenaError}
              </div>
            ) : null}

            {isPreviewMode ? (
              <div className="trade-callout">
                Preview mode is live. Open a specific arena from the bot to unlock trading, rank, and prize tracking.
              </div>
            ) : null}

            {!isPreviewMode && !data.arena && !data.arenaError ? (
              <div className="trade-callout">
                This view is read-only until your arena context loads from Telegram.
              </div>
            ) : null}

            {data.arena && !selectedIsCurrent ? (
              <div className="trade-callout">
                Select the live round to place a trade. Past and upcoming Bayse rounds stay view-only here.
              </div>
            ) : null}

            {data.arena && selectedIsCurrent && !data.market.tradeWindowOpen && !effectiveLock ? (
              <div className="trade-callout">
                Entry window closed for this round. Watch the timer and jump into the next live round.
              </div>
            ) : null}

            {effectiveLock ? (
              <div className="trade-lock-card">
                <div className={`trade-lock-badge ${effectiveLock.direction === 'UP' ? 'is-up' : 'is-down'}`}>
                  {effectiveLock.direction === 'UP' ? 'Buy Up' : 'Buy Down'}
                </div>
                <p>
                  Position locked
                  {effectiveLock.amount ? ` with $${fmtMoney(effectiveLock.amount, 0)}` : ''}
                  . Hold tight until the round settles.
                </p>
              </div>
            ) : (
              <>
                <div className="trade-side-grid">
                  <button
                    type="button"
                    className={`trade-side-button trade-side-up ${selectedDirection === 'UP' ? 'is-selected' : ''}`}
                    onClick={() => pickDirection('UP')}
                    disabled={!canTradeLiveRound || upPct === null}
                  >
                    <span className="trade-side-kicker">Buy Up</span>
                    <span className="trade-side-price">{upPct === null ? '--' : `${upPct}c`}</span>
                  </button>

                  <button
                    type="button"
                    className={`trade-side-button trade-side-down ${selectedDirection === 'DOWN' ? 'is-selected' : ''}`}
                    onClick={() => pickDirection('DOWN')}
                    disabled={!canTradeLiveRound || downPct === null}
                  >
                    <span className="trade-side-kicker">Buy Down</span>
                    <span className="trade-side-price">{downPct === null ? '--' : `${downPct}c`}</span>
                  </button>
                </div>

                {selectedDirection ? (
                  <div className="trade-stake-tray">
                    <div className="trade-stake-top">
                      <button
                        type="button"
                        className="trade-text-button"
                        onClick={() => setSelectedDirection(null)}
                      >
                        Back
                      </button>
                      <span>
                        {selectedDirection === 'UP' ? 'Buy Up' : 'Buy Down'} with virtual bankroll
                      </span>
                    </div>

                    <div className="trade-stake-grid">
                      {TRADE_AMOUNTS.map((amount) => {
                        const balance = data.arena?.virtualBalance ?? 0;
                        const disabled = submitting || !canTradeLiveRound || amount > balance;

                        return (
                          <button
                            key={amount}
                            type="button"
                            className="trade-stake-button"
                            disabled={disabled}
                            onClick={() => void placeTrade(amount)}
                          >
                            ${amount}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}
              </>
            )}

            <div className="trade-footer-actions">
              <a href={BOT_URL} target="_blank" rel="noopener noreferrer" className="trade-button trade-button-secondary">
                Open Telegram bot
              </a>
              {selectedMarketUrl ? (
                <a href={selectedMarketUrl} target="_blank" rel="noopener noreferrer" className="trade-button trade-button-ghost">
                  View on Bayse
                </a>
              ) : null}
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
