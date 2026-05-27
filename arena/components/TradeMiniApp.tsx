import Head from 'next/head';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready(): void;
        expand(): void;
        sendData(data: string): void;
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
  pricePoint: number | null;
}

interface MarketState {
  asset: 'BTC';
  title: string;
  currentPrice: number | null;
  currentRoundId: string | null;
  tradeWindowOpen: boolean;
  round: {
    eventId: string;
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

type Dir = 'UP' | 'DOWN';

interface Receipt {
  direction: Dir;
  amount: number;
  gameCode: string;
  roundNumber: number;
  targetPrice: number | null;
  currentPrice: number | null;
  upPrice: number | null;
  downPrice: number | null;
  placedAt: string;
}

function drawReceipt(receipt: Receipt): string {
  const W = 640, H = 360;
  const canvas = document.createElement('canvas');
  canvas.width = W * 2; canvas.height = H * 2; // retina
  const ctx = canvas.getContext('2d')!;
  ctx.scale(2, 2);

  const isUp = receipt.direction === 'UP';
  const accentColor = isUp ? '#00e676' : '#ff4d6d';

  // Background
  ctx.fillStyle = '#0a0e13';
  ctx.fillRect(0, 0, W, H);

  // Top accent bar
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, 0, W, 4);

  // Brand mark (BTC circle)
  ctx.beginPath();
  ctx.arc(52, 52, 28, 0, Math.PI * 2);
  const grad = ctx.createRadialGradient(52, 52, 0, 52, 52, 28);
  grad.addColorStop(0, '#f7931a');
  grad.addColorStop(1, '#e8820c');
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 22px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('₿', 52, 53);

  // Title
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e8f0f8';
  ctx.font = 'bold 17px -apple-system, sans-serif';
  ctx.fillText('HeadlineOdds Arena', 92, 44);
  ctx.fillStyle = '#6b7f96';
  ctx.font = '13px -apple-system, sans-serif';
  ctx.fillText('Trade Receipt', 92, 64);

  // Direction badge
  const badgeX = W - 24, badgeY = 28;
  ctx.fillStyle = isUp ? 'rgba(0,230,118,0.15)' : 'rgba(255,77,109,0.15)';
  roundRect(ctx, badgeX - 90, badgeY - 18, 90, 32, 8);
  ctx.fill();
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 14px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(isUp ? '↑ BUY UP' : '↓ BUY DOWN', badgeX - 8, badgeY + 6);

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(24, 96); ctx.lineTo(W - 24, 96); ctx.stroke();

  // Stats grid — 4 columns
  const cols = [
    { label: 'STAKE', value: `$${receipt.amount}` },
    { label: 'ARENA', value: receipt.gameCode },
    { label: 'ROUND', value: `#${receipt.roundNumber}` },
    { label: 'PLACED', value: receipt.placedAt },
  ];
  const colW = (W - 48) / 4;
  cols.forEach((col, i) => {
    const x = 24 + i * colW;
    ctx.fillStyle = '#6b7f96';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(col.label, x, 122);
    ctx.fillStyle = '#e8f0f8';
    ctx.font = 'bold 15px -apple-system, sans-serif';
    ctx.fillText(col.value, x, 142);
  });

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.moveTo(24, 160); ctx.lineTo(W - 24, 160); ctx.stroke();

  // Price row
  const priceItems = [
    { label: 'PRICE TARGET', value: receipt.targetPrice !== null ? `$${receipt.targetPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--' },
    { label: 'CURRENT PRICE', value: receipt.currentPrice !== null ? `$${receipt.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '--' },
    { label: 'UP CHANCE', value: receipt.upPrice !== null ? `${Math.round(receipt.upPrice * 100)}%` : '--' },
    { label: 'DOWN CHANCE', value: receipt.downPrice !== null ? `${Math.round(receipt.downPrice * 100)}%` : '--' },
  ];
  priceItems.forEach((item, i) => {
    const x = 24 + i * colW;
    ctx.fillStyle = '#6b7f96';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(item.label, x, 184);
    ctx.fillStyle = i === 2 ? '#00e676' : i === 3 ? '#ff4d6d' : '#e8f0f8';
    ctx.font = 'bold 15px -apple-system, sans-serif';
    ctx.fillText(item.value, x, 204);
  });

  // Divider
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.moveTo(24, 222); ctx.lineTo(W - 24, 222); ctx.stroke();

  // Status line
  ctx.fillStyle = accentColor;
  ctx.font = 'bold 13px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('● Position locked — awaiting round settlement', 24, 248);

  // Footer
  ctx.fillStyle = '#4a5a6e';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText('t.me/HOArena_bot  ·  headlineodds.arena', 24, H - 18);
  ctx.textAlign = 'right';
  ctx.fillText('Bitcoin Up or Down · 15 min', W - 24, H - 18);

  return canvas.toDataURL('image/png');
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function ReceiptModal({ dataUrl, onClose }: { dataUrl: string; onClose: () => void }) {
  async function share() {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], 'hoarena-receipt.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'HOArena Trade Receipt' });
        return;
      }
    } catch { /* fall through to download */ }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'hoarena-receipt.png';
    a.click();
  }

  return (
    <div className="receipt-overlay" onClick={onClose}>
      <div className="receipt-modal" onClick={e => e.stopPropagation()}>
        <img src={dataUrl} alt="Trade receipt" className="receipt-img" />
        <div className="receipt-actions">
          <button type="button" className="btn-primary" onClick={() => void share()}>Save / Share</button>
          <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

const BOT_URL = 'https://t.me/HOArena_bot';
const AMOUNTS = [10, 25, 50, 100];

function fmt$(n: number | null, digits = 2) {
  if (n === null || !Number.isFinite(n)) return '--';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtPct(p: number | null) {
  if (p === null) return '--';
  return `${Math.round(p * 100)}%`;
}

function fmtTime(iso: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

function useCountdown(target: string | null) {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!target) { setMs(0); return; }
    const tick = () => setMs(Math.max(0, Date.parse(target) - Date.now()));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [target]);
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Chart ────────────────────────────────────────────────────────────────────
function Chart({ rounds, selectedId, currentId, target }: {
  rounds: MarketRound[];
  selectedId: string | null;
  currentId: string | null;
  target: number | null;
}) {
  const priced = [...rounds]
    .filter(r => r.pricePoint !== null)
    .sort((a, b) => Date.parse(a.closingDate) - Date.parse(b.closingDate));

  if (priced.length < 2) {
    return <div className="chart-empty">Waiting for round data…</div>;
  }

  const W = 100, H = 60, px = 3, py = 6;
  const vals = priced.map(r => r.pricePoint!);
  const lo = Math.min(...vals) - 30;
  const hi = Math.max(...vals) + 30;
  const span = Math.max(1, priced.length - 1);

  const toX = (i: number) => px + ((W - px * 2) * i) / span;
  const toY = (v: number) => H - py - ((v - lo) / (hi - lo)) * (H - py * 2);

  const pts = priced.map((r, i) => ({ r, x: toX(i), y: toY(r.pricePoint!) }));
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const area = `${line} L${pts.at(-1)!.x},${H - py / 2} L${pts[0]!.x},${H - py / 2}Z`;

  const selPt = pts.find(p => p.r.eventId === selectedId) ?? pts.at(-1)!;
  const curPt = pts.find(p => p.r.eventId === currentId) ?? null;
  const baseY = target !== null ? toY(Math.min(Math.max(target, lo), hi)) : H / 2;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffb347" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#ffb347" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M${px},${baseY} L${W - px},${baseY}`} className="chart-baseline" />
        <path d={area} className="chart-area" />
        <path d={line} className="chart-line" />
        {curPt && <circle cx={curPt.x} cy={curPt.y} r="1.6" className="chart-dot-current" />}
        <circle cx={selPt.x} cy={selPt.y} r="2.2" className="chart-dot-selected" />
        {target !== null && (
          <text x={W - px + 1} y={baseY + 1} className="chart-target-label" textAnchor="start">Target</text>
        )}
      </svg>
      <div className="chart-x-labels">
        <span>{fmtTime(priced[0]!.closingDate)}</span>
        <span>{fmtTime(priced.at(-1)!.closingDate)}</span>
      </div>
    </div>
  );
}

// ─── Loading ──────────────────────────────────────────────────────────────────
function Loading() {
  return (
    <div className="loading-shell">
      <div className="skeleton" style={{ width: 42, height: 42, borderRadius: '50%' }} />
      <div className="skeleton" style={{ width: 200, height: 18, borderRadius: 8 }} />
      <div className="skeleton" style={{ width: 280, height: 14, borderRadius: 8 }} />
      <div className="skeleton" style={{ width: '100%', maxWidth: 360, height: 160, borderRadius: 12 }} />
    </div>
  );
}

// ─── Error ────────────────────────────────────────────────────────────────────
function ErrorScreen({ msg, onRetry }: { msg: string; onRetry: () => void }) {
  return (
    <div className="error-shell">
      <p className="error-title">Market unavailable</p>
      <p className="error-msg">{msg}</p>
      <button type="button" className="btn-primary" onClick={onRetry}>Retry</button>
      <a href={BOT_URL} target="_blank" rel="noopener noreferrer" className="btn-ghost">Open bot</a>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function TradeMiniApp() {
  const [data, setData] = useState<MiniAppState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshErr, setRefreshErr] = useState<string | null>(null);
  const [selRoundId, setSelRoundId] = useState<string | null>(null);
  const [selDir, setSelDir] = useState<Dir | null>(null);
  const [optimistic, setOptimistic] = useState<{ dir: Dir; amount: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);

  const dataRef = useRef<MiniAppState | null>(null);
  const selRoundRef = useRef<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { dataRef.current = data; }, [data]);
  useEffect(() => { selRoundRef.current = selRoundId; }, [selRoundId]);

  async function load() {
    if (typeof window === 'undefined') return;
    const tgId = window.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    const code = new URLSearchParams(window.location.search).get('code')?.trim().toUpperCase();
    const url = new URL('/api/miniapp-state', window.location.origin);
    if (tgId) url.searchParams.set('tgId', String(tgId));
    if (code) url.searchParams.set('code', code);

    try {
      const res = await fetch(url.toString());
      if (!res.ok) {
        const t = await res.text();
        let msg = t;
        try { msg = (JSON.parse(t) as { error?: string }).error ?? t; } catch { /* */ }
        throw new Error(msg || `Error ${res.status}`);
      }
      const next = (await res.json()) as MiniAppState;
      const prevRoundId = dataRef.current?.market.currentRoundId ?? null;
      const curSel = selRoundRef.current;

      setData(next);
      setErr(null);
      setRefreshErr(null);

      if (!curSel || !next.market.rounds.some(r => r.eventId === curSel)) {
        setSelRoundId(next.market.currentRoundId ?? next.market.rounds[0]?.eventId ?? null);
      }
      if (prevRoundId && next.market.currentRoundId && prevRoundId !== next.market.currentRoundId) {
        setSelRoundId(next.market.currentRoundId);
        setSelDir(null);
        setOptimistic(null);
      }
      if (next.arena?.lockedDirection) {
        setSelDir(null);
        setOptimistic(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load market.';
      if (dataRef.current) { setRefreshErr(msg); return; }
      setErr(msg);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    void load();
    pollRef.current = setInterval(() => void load(), 10_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derived state ──────────────────────────────────────────────────────────
  const selRound = data?.market.rounds.find(r => r.eventId === selRoundId) ?? data?.market.rounds[0] ?? null;
  const isCurrent = Boolean(selRound && data?.market.currentRoundId && selRound.eventId === data.market.currentRoundId);

  const upPrice   = selRound?.upPrice   ?? (isCurrent ? (data?.market.pricing?.upPrice   ?? null) : null);
  const downPrice = selRound?.downPrice ?? (isCurrent ? (data?.market.pricing?.downPrice ?? null) : null);
  const upPct   = upPrice   !== null ? Math.round(upPrice   * 100) : null;
  const downPct = downPrice !== null ? Math.round(downPrice * 100) : null;

  const target = selRound?.eventThreshold ?? data?.market.pricing?.eventThreshold ?? data?.market.round?.eventThreshold ?? null;
  const currentPrice = isCurrent ? (data?.market.currentPrice ?? null) : (selRound?.pricePoint ?? null);

  const countdownTarget = selRound?.status === 'upcoming' ? selRound.openingDate : (selRound?.closingDate ?? null);
  const roundCd = useCountdown(countdownTarget);
  const arenaCd = useCountdown(data?.arena?.arenaEndAt ?? null);

  const lock = data?.arena?.lockedDirection
    ? { dir: data.arena.lockedDirection, amount: data.arena.lockedAmount ?? optimistic?.amount ?? null }
    : optimistic
      ? { dir: optimistic.dir, amount: optimistic.amount }
      : null;

  const canTrade = Boolean(
    data?.arena && selRound && isCurrent &&
    data.market.tradeWindowOpen && data.arena.ref &&
    upPct !== null && downPct !== null
  );

  const returnPct = data?.arena
    ? ((data.arena.virtualBalance - data.arena.virtualStartBalance) / data.arena.virtualStartBalance) * 100
    : null;

  const isPreview = !data?.arena && !data?.requestedCode && !data?.arenaError;

  // ── Resolve rule text ──────────────────────────────────────────────────────
  function ruleText() {
    if (!selRound || !target) return null;
    const close = new Date(selRound.closingDate);
    const dateStr = close.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const timeStr = close.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    return (
      <>
        This market will resolve as <span className="up">Up</span> if the price of Bitcoin at exactly {timeStr} on {dateStr} is higher than or equal to the price at the start of the period ({fmt$(target)}). This market will resolve as <span className="down">Down</span> if the price of Bitcoin is lower.
      </>
    );
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function pickDir(d: Dir) {
    if (!canTrade || lock) return;
    window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
    setSelDir(prev => prev === d ? null : d);
  }

  async function placeTrade(amount: number) {
    if (!selDir || !data?.arena || !canTrade || submitting) return;
    setSubmitting(true);
    try {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
      window.Telegram?.WebApp?.sendData(JSON.stringify({ action: 'trade', direction: selDir, amount, ref: data.arena.ref }));
      setOptimistic({ dir: selDir, amount });
      setSelDir(null);
      // Generate receipt image
      const url = drawReceipt({
        direction: selDir,
        amount,
        gameCode: data.arena.gameCode,
        roundNumber: data.arena.roundNumber,
        targetPrice: target,
        currentPrice,
        upPrice,
        downPrice,
        placedAt: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      });
      setReceiptUrl(url);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const head = (
    <Head>
      <title>Bitcoin Up or Down – 15 min · HOArena</title>
      <meta name="theme-color" content="#0a0e13" />
      <script src="https://telegram.org/js/telegram-web-app.js" />
    </Head>
  );

  if (err) return <>{head}<ErrorScreen msg={err} onRetry={() => void load()} /></>;
  if (!data || !selRound) return <>{head}<Loading /></>;

  const marketUrl = selRound.marketUrl ?? data.market.marketUrl ?? null;

  return (
    <>
      {head}
      {receiptUrl && <ReceiptModal dataUrl={receiptUrl} onClose={() => setReceiptUrl(null)} />}
      <div className="shell">

        {/* ── Header ── */}
        <header className="hdr">
          <div className="hdr-icon" aria-hidden="true">₿</div>
          <h1 className="hdr-title">Bitcoin Up or Down – 15 minutes?</h1>
          <div className="hdr-actions">
            <button type="button" className="hdr-btn" onClick={() => void load()} aria-label="Refresh" title="Refresh">↻</button>
            {marketUrl && (
              <a href={marketUrl} target="_blank" rel="noopener noreferrer" className="hdr-btn" title="View on Bayse">↗</a>
            )}
          </div>
        </header>

        {refreshErr && <div className="banner">{refreshErr}</div>}

        {/* ── Price Row ── */}
        <div className="price-row">
          <div className="price-col">
            <div className="price-label">Price Target</div>
            <div className="price-value">{fmt$(target)}</div>
          </div>
          <div className="price-divider" />
          <div className="price-col">
            <div className="price-label">Current Price</div>
            <div className={`price-value${isCurrent ? ' is-live' : ''}`}>{fmt$(currentPrice)}</div>
          </div>
          <div className="price-divider" />
          <div>
            {selRound.status === 'closed'
              ? <div className="countdown is-closed">Closed</div>
              : <div className="countdown is-open">{roundCd} ✕</div>
            }
          </div>
        </div>

        {/* ── Chance % ── */}
        <div className="chance-row">
          <div>
            <div className="chance-pct">{fmtPct(upPrice)}</div>
            <div className="chance-label">Chance</div>
          </div>
          {upPct !== null && (
            <div className="chance-trend">
              ↑ {upPct}% today
            </div>
          )}
        </div>

        {/* ── Chart ── */}
        <Chart
          rounds={data.market.rounds}
          selectedId={selRound.eventId}
          currentId={data.market.currentRoundId}
          target={target}
        />

        {/* ── Rounds Rail ── */}
        <div className="rounds-section">
          <div className="rounds-label">Rounds</div>
          <div className="rounds-rail" role="list">
            {data.market.rounds.map(r => (
              <button
                key={r.eventId}
                type="button"
                className={`round-chip${r.eventId === selRound.eventId ? ' is-selected' : ''}`}
                onClick={() => {
                  window.Telegram?.WebApp?.HapticFeedback?.selectionChanged();
                  setSelRoundId(r.eventId);
                  setSelDir(null);
                }}
                aria-pressed={r.eventId === selRound.eventId}
              >
                <span className={`round-dot round-dot-${r.status}`} aria-hidden="true" />
                {fmtTime(r.closingDate)}
              </button>
            ))}
          </div>
        </div>

        {/* ── Market Rules ── */}
        {ruleText() && (
          <div className="rules-strip">
            <div className="rules-title">Market Rules &amp; Timelines</div>
            <div className="rules-body">{ruleText()}</div>
          </div>
        )}

        {/* ── Arena Stats ── */}
        {data.arena ? (
          <div className="stats-grid">
            <div className="stat-card">
              <span className="stat-label">Arena</span>
              <span className="stat-value">{data.arena.gameCode}</span>
              <span className="stat-sub">Round #{data.arena.roundNumber}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Stack</span>
              <span className="stat-value">{fmt$(data.arena.virtualBalance)}</span>
              <span className={`stat-sub${returnPct === null ? '' : returnPct >= 0 ? ' pos' : ' neg'}`}>
                {returnPct === null ? '' : `${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(1)}%`}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Rank</span>
              <span className="stat-value">#{data.arena.place}</span>
              <span className="stat-sub">of {data.arena.memberCount}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Prize</span>
              <span className="stat-value">{fmt$(data.arena.prizeIfEndedNow)}</span>
              <span className="stat-sub">ends {arenaCd}</span>
            </div>
          </div>
        ) : null}

        {/* ── Callouts ── */}
        {data.arenaError && <div className="callout err">{data.arenaError}</div>}
        {isPreview && <div className="callout">Preview mode — open an arena from the bot to trade.</div>}
        {!isPreview && !data.arena && !data.arenaError && (
          <div className="callout">Loading your arena context…</div>
        )}
        {data.arena && !isCurrent && (
          <div className="callout">Select the live round to place a trade.</div>
        )}
        {data.arena && isCurrent && !data.market.tradeWindowOpen && !lock && (
          <div className="callout">Entry window closed — wait for the next round.</div>
        )}

        {/* ── Lock card ── */}
        {lock && (
          <div className="lock-card">
            <span className={`lock-badge ${lock.dir === 'UP' ? 'up' : 'down'}`}>
              {lock.dir === 'UP' ? 'Buy Up' : 'Buy Down'}
            </span>
            <p>Position locked{lock.amount ? ` · $${lock.amount}` : ''}. Hold until the round settles.</p>
          </div>
        )}

        <div className="footer-spacer" />

        {/* ── Sticky Footer ── */}
        <footer className="footer">
          {lock ? null : (
            <>
              <div className="dir-grid">
                <button
                  type="button"
                  className={`dir-btn up${selDir === 'UP' ? ' is-selected' : ''}`}
                  onClick={() => pickDir('UP')}
                  disabled={!canTrade || upPct === null}
                >
                  <span className="dir-label">Buy Up</span>
                  <span className="dir-price">
                    {upPct === null ? '--' : `₦${upPct}`}
                  </span>
                </button>
                <button
                  type="button"
                  className={`dir-btn down${selDir === 'DOWN' ? ' is-selected' : ''}`}
                  onClick={() => pickDir('DOWN')}
                  disabled={!canTrade || downPct === null}
                >
                  <span className="dir-label">Buy Down</span>
                  <span className="dir-price">
                    {downPct === null ? '--' : `₦${downPct}`}
                  </span>
                </button>
              </div>

              {selDir && (
                <div className="stake-tray">
                  <div className="stake-back">
                    <button type="button" onClick={() => setSelDir(null)}>← Back</button>
                    <span>{selDir === 'UP' ? 'Buy Up' : 'Buy Down'} — pick amount</span>
                  </div>
                  <div className="stake-grid">
                    {AMOUNTS.map(amt => (
                      <button
                        key={amt}
                        type="button"
                        className="stake-btn"
                        disabled={submitting || !canTrade || amt > (data.arena?.virtualBalance ?? 0)}
                        onClick={() => void placeTrade(amt)}
                      >
                        ${amt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </footer>

      </div>
    </>
  );
}
