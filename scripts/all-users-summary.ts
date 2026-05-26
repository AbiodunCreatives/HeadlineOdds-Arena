import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../src/config.ts";
import { supabase } from "../src/db/client.ts";
import { listFantasyWallets } from "../src/db/wallets.ts";

const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");

async function main() {
  const [wallets, { data: users }] = await Promise.all([
    listFantasyWallets(),
    supabase.from("fantasy_users").select("telegram_id,username,wallet_balance,last_seen_at"),
  ]);

  const userMap = new Map((users ?? []).map((u: any) => [Number(u.telegram_id), u]));

  const rows = await Promise.all(wallets.map(async (w) => {
    let onchain = 0;
    try {
      const bal = await connection.getTokenAccountBalance(new PublicKey(w.usdc_ata), "confirmed");
      onchain = Number(bal.value.amount) / 1_000_000;
    } catch { }
    const u = userMap.get(w.telegram_id) as any;
    const lastSeen = u?.last_seen_at ? new Date(u.last_seen_at).toLocaleString("en-GB", { timeZone: "UTC", hour12: false }) + " UTC" : "—";
    return { telegram_id: w.telegram_id, username: u?.username ?? "—", onchain, db_balance: Number(u?.wallet_balance ?? 0), last_seen: lastSeen };
  }));

  rows.sort((a, b) => b.onchain - a.onchain);

  const C = [16, 22, 16, 14, 24];
  const header = ["telegram_id","username","on_chain_usdc","db_balance","last_seen_at"];
  const line = "=".repeat(C.reduce((a,b)=>a+b,0));
  console.log("\nAll Users Summary");
  console.log(line);
  console.log(header.map((h,i) => h.padEnd(C[i])).join(""));
  console.log("-".repeat(line.length));
  for (const r of rows) {
    console.log(
      String(r.telegram_id).padEnd(C[0]) +
      r.username.padEnd(C[1]) +
      r.onchain.toFixed(6).padEnd(C[2]) +
      r.db_balance.toFixed(6).padEnd(C[3]) +
      r.last_seen
    );
  }
  console.log("-".repeat(line.length));
  console.log(`${"TOTAL".padEnd(C[0]+C[1])}${rows.reduce((s,r)=>s+r.onchain,0).toFixed(6)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
