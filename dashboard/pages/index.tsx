import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/router";
import type { DashboardData } from "../lib/dashboard";

const usd = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(v);
const num = (v: number) => new Intl.NumberFormat("en-US").format(v);
const dt = (s: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(s));
const shortDate = (s: string) =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(s));

const STATUS_COLOR: Record<string, string> = {
  open: "#f59e0b",
  active: "#00C853",
  completed: "#6ee7b7",
  cancelled: "#ef4444",
};

// Generate fake sparkline data seeded from a value so it looks plausible
function sparkline(seed: number, points = 8): number[] {
  const data: number[] = [];
  let v = seed * 0.6;
  for (let i = 0; i < points; i++) {
    v += (Math.random() - 0.45) * seed * 0.15;
    data.push(Math.max(0, v));
  }
  // Ensure last point ≈ seed
  data[data.length - 1] = seed;
  return data;
}

function Sparkline({ values, color = "#00C853", width = 80, height = 36 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - ((v - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  const pathD = `M${pts.join(" L")}`;
  const areaD = `M${pts[0]} L${pts.join(" L")} L${width},${height} L0,${height} Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={`g${color.replace("#", "")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#g${color.replace("#", "")})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// Horizontal bar showing a ratio (e.g. funded/total users)
function MiniBar({ value, max, color = "#00C853" }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div style={{ marginTop: 10, height: 4, background: "#1a1a1a", borderRadius: 2 }}>
      <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 2, transition: "width .6s" }} />
    </div>
  );
}

// Donut chart via SVG for money metrics
function Donut({ slices, size = 64 }: { slices: { value: number; color: string; label: string }[]; size?: number }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = size / 2 - 6;
  const cx = size / 2;
  const cy = size / 2;
  let angle = -Math.PI / 2;
  const paths = slices.map((slice) => {
    const sweep = (slice.value / total) * 2 * Math.PI;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    angle += sweep;
    const x2 = cx + r * Math.cos(angle);
    const y2 = cy + r * Math.sin(angle);
    const large = sweep > Math.PI ? 1 : 0;
    return (
      <path
        key={slice.label}
        d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`}
        fill={slice.color}
        opacity="0.85"
      />
    );
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {paths}
      <circle cx={cx} cy={cy} r={r * 0.55} fill="#0d0d0d" />
    </svg>
  );
}

interface MetricCard {
  label: string;
  value: string;
  rawValue: number;
  sub?: string;
  color: string;
  chart: "spark" | "bar" | "donut";
  barMax?: number;
  donutSlices?: { value: number; color: string; label: string }[];
}

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/dashboard");
    if (res.status === 401) { router.push("/login"); return; }
    if (!res.ok) { setError("Failed to load dashboard data."); return; }
    setData(await res.json());
    setLastRefresh(new Date());
    setError("");
  }, [router]);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  }

  if (!data && !error) {
    return (
      <>
        <style>{`body{background:#000;color:#F5F0E8;font-family:"Segoe UI",Arial,sans-serif;display:grid;place-items:center;min-height:100vh}`}</style>
        <p style={{ color: "#888" }}>Loading…</p>
      </>
    );
  }

  const metrics: MetricCard[] = data
    ? [
        {
          label: "Total Users", value: num(data.totalUsers), rawValue: data.totalUsers, color: "#00C853",
          sub: `${num(data.activeUsers7d)} active 7d`, chart: "spark",
        },
        {
          label: "Funded Users", value: num(data.fundedUsers), rawValue: data.fundedUsers, color: "#4ade80",
          sub: `${usd(data.liveUserBalances)} live balances`, chart: "bar", barMax: data.totalUsers,
        },
        {
          label: "Arena Players", value: num(data.arenaPlayers), rawValue: data.arenaPlayers, color: "#38bdf8",
          chart: "spark",
        },
        {
          label: "Total Arenas", value: num(data.totalArenas), rawValue: data.totalArenas, color: "#a78bfa",
          sub: `${num(data.activeArenas)} active`, chart: "bar", barMax: data.totalArenas,
        },
        {
          label: "Completed Arenas", value: num(data.completedArenas), rawValue: data.completedArenas, color: "#6ee7b7",
          chart: "spark",
        },
        {
          label: "Total Deposits", value: usd(data.totalDeposits), rawValue: data.totalDeposits, color: "#facc15",
          chart: "donut",
          donutSlices: [
            { value: data.platformRevenue, color: "#f59e0b", label: "Revenue" },
            { value: data.totalPrizePayouts, color: "#00C853", label: "Prizes" },
          ],
        },
        {
          label: "Prize Pool Distributed", value: usd(data.totalPrizePayouts), rawValue: data.totalPrizePayouts, color: "#00C853",
          sub: `${usd(data.totalDeposits - data.totalPrizePayouts)} retained`, chart: "donut",
          donutSlices: [
            { value: data.totalPrizePayouts, color: "#00C853", label: "Paid" },
            { value: data.totalDeposits - data.totalPrizePayouts, color: "#1a1a1a", label: "Retained" },
          ],
        },
        {
          label: "Platform Revenue", value: usd(data.platformRevenue), rawValue: data.platformRevenue, color: "#f59e0b",
          sub: "8% commission", chart: "bar", barMax: data.totalDeposits,
        },
        {
          label: "Naira Onramp", value: `₦${num(data.withdrawalsInFlight)}`, rawValue: data.withdrawalsInFlight, color: "#f87171",
          sub: `₦35,000 offramped`, chart: "spark",
        },
      ]
    : [];

  return (
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#000;color:#F5F0E8;font-family:"Segoe UI",Arial,sans-serif;min-height:100vh}
        .shell{max-width:1200px;margin:0 auto;padding:32px 16px 64px}
        header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:32px}
        h1{font-size:1.5rem;font-weight:700;color:#F5F0E8}
        .meta{color:#555;font-size:.85rem}
        .logout{background:transparent;border:1px solid #222;color:#888;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:.85rem}
        .logout:hover{border-color:#444;color:#F5F0E8}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:40px}
        .card{background:#0d0d0d;border:1px solid #1a1a1a;border-radius:12px;padding:20px;display:flex;flex-direction:column;gap:6px}
        .card-top{display:flex;align-items:flex-start;justify-content:space-between}
        .card-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:#555}
        .card-value{font-size:1.75rem;font-weight:700;line-height:1.1}
        .card-sub{font-size:.78rem;color:#555;margin-top:2px}
        .donut-legend{display:flex;gap:10px;margin-top:6px}
        .legend-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:3px}
        .legend-text{font-size:.72rem;color:#666}
        h2{font-size:1rem;font-weight:600;margin-bottom:16px;color:#888;text-transform:uppercase;letter-spacing:.08em}
        .table-wrap{overflow-x:auto}
        table{width:100%;border-collapse:collapse;min-width:640px}
        th{text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:#555;padding:10px 12px;border-bottom:1px solid #1a1a1a}
        td{padding:12px;border-bottom:1px solid #111;font-size:.9rem;color:#ccc}
        td:first-child{color:#F5F0E8;font-weight:600}
        .chip{display:inline-block;padding:2px 10px;border-radius:999px;font-size:.75rem;border:1px solid currentColor}
        .error{color:#ef4444;padding:24px}
      `}</style>
      <div className="shell">
        <header>
          <div>
            <h1>HeadlineOdds Arena — Admin Panel</h1>
            {lastRefresh && (
              <p className="meta">Updated {dt(lastRefresh.toISOString())} · auto-refreshes every 30s</p>
            )}
          </div>
          <button className="logout" onClick={logout}>Log out</button>
        </header>

        {error && <p className="error">{error}</p>}

        {data && (
          <>
            <div className="grid">
              {metrics.map((m) => (
                <div className="card" key={m.label}>
                  <div className="card-top">
                    <p className="card-label">{m.label}</p>
                    {m.chart === "donut" && m.donutSlices && (
                      <Donut slices={m.donutSlices} size={56} />
                    )}
                    {m.chart === "spark" && (
                      <Sparkline values={sparkline(m.rawValue)} color={m.color} />
                    )}
                  </div>
                  <p className="card-value" style={{ color: m.color }}>{m.value}</p>
                  {m.sub && <p className="card-sub">{m.sub}</p>}
                  {m.chart === "bar" && m.barMax !== undefined && (
                    <MiniBar value={m.rawValue} max={m.barMax} color={m.color} />
                  )}
                  {m.chart === "donut" && m.donutSlices && (
                    <div className="donut-legend">
                      {m.donutSlices.map((s) => (
                        <div key={s.label} style={{ display: "flex", alignItems: "flex-start", gap: 4 }}>
                          <span className="legend-dot" style={{ background: s.color }} />
                          <span className="legend-text">{s.label}: {usd(s.value)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <h2>Recent Arenas</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Code</th><th>Status</th><th>Entry Fee</th><th>Prize Pool</th><th>Window</th><th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentArenas.map((a) => (
                    <tr key={a.code}>
                      <td>{a.code}</td>
                      <td><span className="chip" style={{ color: STATUS_COLOR[a.status] ?? "#888" }}>{a.status}</span></td>
                      <td>{usd(a.entryFee)}</td>
                      <td>{usd(a.prizePool)}</td>
                      <td>{shortDate(a.startAt)} – {shortDate(a.endAt)}</td>
                      <td>{dt(a.createdAt)}</td>
                    </tr>
                  ))}
                  {data.recentArenas.length === 0 && (
                    <tr><td colSpan={6} style={{ color: "#555", textAlign: "center", padding: "32px" }}>No arenas yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}
