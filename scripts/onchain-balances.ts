import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../src/config.ts";
import { supabase } from "../src/db/client.ts";
import { listFantasyWallets } from "../src/db/wallets.ts";

const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");

async function getOnChainUsdcBalance(usdcAta: string): Promise<number> {
  try {
    const balance = await connection.getTokenAccountBalance(
      new PublicKey(usdcAta),
      "confirmed"
    );
    return Number(balance.value.amount) / 1_000_000;
  } catch {
    return 0;
  }
}

async function getUsernames(): Promise<Map<number, string>> {
  const { data, error } = await supabase
    .from("fantasy_users")
    .select("telegram_id, username");
  if (error) throw error;
  return new Map(
    (data ?? []).map((r) => [Number(r.telegram_id), (r.username as string | null) ?? "—"])
  );
}

async function main() {
  const [wallets, usernames] = await Promise.all([listFantasyWallets(), getUsernames()]);

  if (wallets.length === 0) {
    console.log("No wallets found.");
    return;
  }

  const results = await Promise.all(
    wallets.map(async (w) => ({
      telegram_id: w.telegram_id,
      username: usernames.get(w.telegram_id) ?? "—",
      onchain_usdc: await getOnChainUsdcBalance(w.usdc_ata),
      owner_address: w.owner_address,
    }))
  );

  results.sort((a, b) => b.onchain_usdc - a.onchain_usdc);

  console.log("\nUser On-Chain USDC Balances");
  console.log("=".repeat(90));
  console.log(
    "telegram_id".padEnd(16) +
    "username".padEnd(22) +
    "on_chain_usdc".padEnd(18) +
    "owner_address"
  );
  console.log("-".repeat(90));

  for (const r of results) {
    console.log(
      String(r.telegram_id).padEnd(16) +
      r.username.padEnd(22) +
      r.onchain_usdc.toFixed(6).padEnd(18) +
      r.owner_address
    );
  }

  const total = results.reduce((s, r) => s + r.onchain_usdc, 0);
  console.log("-".repeat(90));
  console.log(`${"TOTAL".padEnd(38)}${total.toFixed(6)}`);
  console.log(`\n${results.length} wallet(s) queried.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
