import { supabase } from "../src/db/client.ts";

async function main() {
  const { error, count } = await supabase
    .from("fantasy_wallet_ledger")
    .delete({ count: "exact" })
    .not("entry_type", "in", '("offramp_request","withdrawal_request")');

  if (error) { console.error(error); process.exit(1); }
  console.log(`Deleted ${count} ledger entries.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
