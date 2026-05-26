import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../src/config.ts";
import { supabase } from "../src/db/client.ts";

const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");

async function main() {
  const { data: user } = await supabase
    .from("fantasy_users")
    .select("telegram_id, username")
    .ilike("username", "%hollyboy%")
    .maybeSingle();

  if (!user) { console.log("User 'hollyboy' not found."); return; }

  const { data: wallet } = await supabase
    .from("fantasy_wallets")
    .select("owner_address, usdc_ata, last_seen_usdc_balance_raw")
    .eq("telegram_id", user.telegram_id)
    .maybeSingle();

  if (!wallet) { console.log(`No wallet for ${user.username}.`); return; }

  let onchain = 0;
  try {
    const bal = await connection.getTokenAccountBalance(new PublicKey(wallet.usdc_ata), "confirmed");
    onchain = Number(bal.value.amount) / 1_000_000;
  } catch { onchain = 0; }

  console.log(`User:          ${user.username} (${user.telegram_id})`);
  console.log(`Owner address: ${wallet.owner_address}`);
  console.log(`On-chain USDC: $${onchain.toFixed(6)}`);
  console.log(`Last DB sync:  $${(Number(wallet.last_seen_usdc_balance_raw) / 1_000_000).toFixed(6)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
