import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

export interface TradeReceiptInput {
  direction: "UP" | "DOWN";
  stake: number;
  gameCode: string;
  roundNumber: number;
  targetPrice: number | null;
  currentPrice: number | null;
  upPrice: number | null;
  downPrice: number | null;
  remainingBalance: number;
  placedAt?: Date;
}

export function generateTradeReceiptPng(input: TradeReceiptInput): Buffer {
  const W = 640, H = 360;
  const canvas = createCanvas(W * 2, H * 2);
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);

  const isUp = input.direction === "UP";
  const accent = isUp ? "#00e676" : "#ff4d6d";
  const fmt$ = (n: number | null) =>
    n === null ? "--" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtPct = (p: number | null) => (p === null ? "--" : `${Math.round(p * 100)}%`);
  const timeStr = (input.placedAt ?? new Date()).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });

  // Background
  ctx.fillStyle = "#0a0e13";
  ctx.fillRect(0, 0, W, H);

  // Top accent bar
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, 4);

  // BTC circle
  ctx.beginPath();
  ctx.arc(52, 52, 28, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(52, 52, 0, 52, 52, 28);
  g.addColorStop(0, "#f7931a");
  g.addColorStop(1, "#e8820c");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("₿", 52, 53);

  // Title
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#e8f0f8";
  ctx.font = "bold 17px sans-serif";
  ctx.fillText("HeadlineOdds Arena", 92, 44);
  ctx.fillStyle = "#6b7f96";
  ctx.font = "13px sans-serif";
  ctx.fillText("Trade Receipt", 92, 64);

  // Direction badge
  ctx.fillStyle = isUp ? "rgba(0,230,118,0.15)" : "rgba(255,77,109,0.15)";
  roundRect(ctx, W - 120, 18, 96, 30, 8);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(isUp ? "↑ BUY UP" : "↓ BUY DOWN", W - 16, 38);

  // Divider
  line(ctx, 24, 96, W - 24, 96);

  // Row 1: Stake · Arena · Round · Time
  const cols = [
    { label: "STAKE",   value: fmt$(input.stake) },
    { label: "ARENA",   value: input.gameCode },
    { label: "ROUND",   value: `#${input.roundNumber}` },
    { label: "PLACED",  value: timeStr },
  ];
  const cw = (W - 48) / 4;
  cols.forEach(({ label, value }, i) => {
    const x = 24 + i * cw;
    ctx.fillStyle = "#6b7f96";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, x, 122);
    ctx.fillStyle = "#e8f0f8";
    ctx.font = "bold 15px sans-serif";
    ctx.fillText(value, x, 142);
  });

  // Divider
  line(ctx, 24, 160, W - 24, 160);

  // Row 2: Target · Current · Up% · Down% · Balance
  const row2 = [
    { label: "PRICE TARGET",  value: fmt$(input.targetPrice),  color: "#e8f0f8" },
    { label: "CURRENT PRICE", value: fmt$(input.currentPrice), color: "#ffb347" },
    { label: "UP CHANCE",     value: fmtPct(input.upPrice),    color: "#00e676" },
    { label: "DOWN CHANCE",   value: fmtPct(input.downPrice),  color: "#ff4d6d" },
  ];
  row2.forEach(({ label, value, color }, i) => {
    const x = 24 + i * cw;
    ctx.fillStyle = "#6b7f96";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(label, x, 184);
    ctx.fillStyle = color;
    ctx.font = "bold 15px sans-serif";
    ctx.fillText(value, x, 204);
  });

  // Divider
  line(ctx, 24, 222, W - 24, 222);

  // Balance line
  ctx.fillStyle = "#6b7f96";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("REMAINING BALANCE", 24, 244);
  ctx.fillStyle = "#e8f0f8";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText(fmt$(input.remainingBalance), 24, 264);

  // Status
  ctx.fillStyle = accent;
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("● Position locked — awaiting settlement", W - 24, 264);

  // Footer
  ctx.fillStyle = "#4a5a6e";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("t.me/HOArena_bot", 24, H - 18);
  ctx.textAlign = "right";
  ctx.fillText("Bitcoin Up or Down · 15 min", W - 24, H - 18);

  return canvas.toBuffer("image/png");
}

function line(ctx: SKRSContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
