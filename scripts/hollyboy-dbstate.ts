import { supabase } from "../src/db/client.ts";

async function main() {
  const { data: u } = await supabase
    .from("fantasy_users")
    .select("telegram_id,username,wallet_balance")
    .eq("telegram_id", 6545367105)
    .single();
  console.log("fantasy_users:", JSON.stringify(u));

  const { data: l } = await supabase
    .from("fantasy_wallet_ledger")
    .select("entry_type,direction,amount,metadata,created_at")
    .eq("telegram_id", 6545367105)
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("ledger (recent):", JSON.stringify(l, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
