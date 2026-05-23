import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

declare global {
  interface Window {
    Telegram: {
      WebApp: {
        ready(): void;
        expand(): void;
        sendData(data: string): void;
        close(): void;
        initDataUnsafe: { user?: { id: number } };
        themeParams: { bg_color?: string };
        MainButton: {
          setText(t: string): void;
          show(): void;
          hide(): void;
          onClick(fn: () => void): void;
          offClick(fn: () => void): void;
          showProgress(leaveActive: boolean): void;
          hideProgress(): void;
          isVisible: boolean;
        };
      };
    };
  }
}

interface TradeState {
  gameCode: string;
  roundNumber: number;
  btcPrice: number | null;
  referencePrice: number | null;
  upPrice: number;
  downPrice: number;
  roundClosingDate: string;
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

const API_BASE = process.env.NEXT_PUBLIC_BOT_API_URL ?? '';
const TRADE_AMOUNTS = [10, 25, 50, 100];

function fmt(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPrice(n: number | null) {
  if (!n) return '—';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function useCountdown(target: string | null) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!target) return;
    const tick = () => setMs(Math.max(0, Date.parse(target) - Date.now()));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [target]);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function TradePage() {
  const [state, setState] = useState<TradeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<'direction' | 'stake' | 'locked'>('direction');
  const [direction, setDirection] = useState<'UP' | 'DOWN' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const roundCountdown = useCountdown(state?.roundClosingDate ?? null);
  const arenaCountdown = useCountdown(state?.arenaEndAt ?? null);

  const tgId = typeof window !== 'undefined'
    ? window.Telegram?.WebApp?.initDataUnsafe?.user?.id
    : undefined;

  const code = typeof window !== 'undefined'
    ? new URLSearchParams(window.location.search).get('code')
    : null;

  async function fetchState() {
    if (!tgId || !code) return;
    try {
      const res = await fetch(`${API_BASE}/api/trade-state?tgId=${tgId}&code=${code}`);
      if (!res.ok) throw new Error(await res.text());
      const data: TradeState = await res.json();
      setState(data);
      if (data.lockedDirection) {
        setStage('locked');
        setDirection(data.lockedDirection);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    fetchState();
    pollRef.current = setInterval(fetchState, 8000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickDirection(d: 'UP' | 'DOWN') {
    setDirection(d);
    setStage('stake');
  }

  async function placeTrade(amount: number) {
    if (!direction || !state || submitting) return;
    setSubmitting(true);
    const payload = JSON.stringify({ action: 'trade', direction, amount, ref: state.ref });
    window.Telegram?.WebApp?.sendData(payload);
    // Optimistically show locked
    setStage('locked');
    setSubmitting(false);
  }

  function back() {
    setStage('direction');
    setDirection(null);
  }

  if (error) return (
    <div className="trade-error">
      <p>{error}</p>
      <button onClick={fetchState}>Retry</button>
    </div>
  );

  if (!state) return (
    <div className="trade-loading">
      <div className="spinner" />
      <p>Loading arena…</p>
    </div>
  );

  const returnPct = ((state.virtualBalance - state.virtualStartBalance) / state.virtualStartBalance) * 100;
  const returnSign = returnPct >= 0 ? '+' : '';
  const upPct = Math.round(state.upPrice * 100);
  const downPct = Math.round(state.downPrice * 100);

  return (
    <>
      <Head>
        <title>Arena {state.gameCode}</title>
        <script src="https://telegram.org/js/telegram-web-app.js" />
      </Head>

      <div className="trade-root">
        {/* Header bar */}
        <div className="trade-header">
          <div className="trade-header-left">
            <span className="trade-code">{state.gameCode}</span>
            <span className="trade-live-dot" />
            <span className="trade-live-label">LIVE</span>
          </div>
          <div className="trade-header-right">
            <span className="trade-arena-timer">{arenaCountdown}</span>
          </div>
        </div>

        {/* BTC price + question */}
        <div className="trade-market">
          <div className="trade-btc-price">{fmtPrice(state.btcPrice)}</div>
          <div className="trade-question">
            Will BTC be above {fmtPrice(state.referencePrice)} when this round closes?
          </div>
          <div className="trade-round-meta">
            <span>Round #{state.roundNumber}</span>
            <span className="trade-sep">·</span>
            <span className="trade-round-timer">{roundCountdown}</span>
          </div>
        </div>

        {/* Odds bar */}
        <div className="trade-odds">
          <div className="trade-odds-yes" style={{ width: `${upPct}%` }}>
            <span>YES {upPct}¢</span>
          </div>
          <div className="trade-odds-no" style={{ width: `${downPct}%` }}>
            <span>NO {downPct}¢</span>
          </div>
        </div>

        {/* Trade panel */}
        <div className="trade-panel">
          {!state.tradeWindowOpen && stage !== 'locked' && (
            <div className="trade-window-closed">
              Entry window closed for this round
            </div>
          )}

          {state.tradeWindowOpen && stage === 'direction' && (
            <div className="trade-direction">
              <p className="trade-panel-label">Your prediction</p>
              <div className="trade-dir-buttons">
                <button className="btn-yes" onClick={() => pickDirection('UP')}>
                  <span className="dir-arrow">↑</span>
                  <span className="dir-label">YES</span>
                  <span className="dir-odds">{upPct}¢</span>
                </button>
                <button className="btn-no" onClick={() => pickDirection('DOWN')}>
                  <span className="dir-arrow">↓</span>
                  <span className="dir-label">NO</span>
                  <span className="dir-odds">{downPct}¢</span>
                </button>
              </div>
            </div>
          )}

          {state.tradeWindowOpen && stage === 'stake' && direction && (
            <div className="trade-stake">
              <div className="trade-stake-header">
                <button className="btn-back" onClick={back}>←</button>
                <span className="trade-panel-label">
                  {direction === 'UP' ? '↑ YES' : '↓ NO'} — pick amount
                </span>
              </div>
              <div className="trade-amounts">
                {TRADE_AMOUNTS.map(amt => (
                  <button
                    key={amt}
                    className="btn-amount"
                    disabled={submitting || amt > state.virtualBalance}
                    onClick={() => placeTrade(amt)}
                  >
                    {amt}
                  </button>
                ))}
              </div>
            </div>
          )}

          {stage === 'locked' && direction && (
            <div className="trade-locked">
              <div className={`trade-locked-badge ${direction === 'UP' ? 'locked-yes' : 'locked-no'}`}>
                {direction === 'UP' ? '↑ YES' : '↓ NO'}
                {state.lockedAmount ? ` · ${state.lockedAmount} USDC` : ''}
              </div>
              <p className="trade-locked-msg">Position locked for this round</p>
            </div>
          )}
        </div>

        {/* Stats footer */}
        <div className="trade-stats">
          <div className="trade-stat">
            <span className="stat-label">Stack</span>
            <span className="stat-value">${fmt(state.virtualBalance)}</span>
            <span className={`stat-sub ${returnPct >= 0 ? 'pos' : 'neg'}`}>
              {returnSign}{returnPct.toFixed(1)}%
            </span>
          </div>
          <div className="trade-stat">
            <span className="stat-label">Rank</span>
            <span className="stat-value">#{state.place}</span>
            <span className="stat-sub">of {state.memberCount}</span>
          </div>
          <div className="trade-stat">
            <span className="stat-label">Prize</span>
            <span className="stat-value">${fmt(state.prizeIfEndedNow)}</span>
            <span className="stat-sub">if ended now</span>
          </div>
        </div>
      </div>
    </>
  );
}
