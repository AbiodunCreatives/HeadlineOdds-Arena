import { supabase } from "../src/db/client.ts";

async function main() {
  const { data: users } = await supabase
    .from("fantasy_users")
    .select("telegram_id, username");

  const { data: ledger, error } = await supabase
    .from("fantasy_wallet_ledger")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) { console.error(error); process.exit(1); }

  const nameMap = new Map((users ?? []).map((u) => [Number(u.telegram_id), (u.username as string) ?? "—"]));

  const byUser = new Map<number, typeof ledger>();
  for (const e of ledger ?? []) {
    const tid = Number(e.telegram_id);
    if (!byUser.has(tid)) byUser.set(tid, []);
    byUser.get(tid)!.push(e);
  }

  for (const [tid, entries] of byUser) {
    const name = nameMap.get(tid) ?? "—";
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  ${name} (${tid})`);
    console.log("═".repeat(70));
    console.log("date".padEnd(22) + "type".padEnd(28) + "dir".padEnd(8) + "amount".padEnd(12) + "status");
    console.log("─".repeat(70));
    for (const e of entries!) {
      const date = new Date(e.created_at as string).toISOString().replace("T", " ").slice(0, 19);
      console.log(
        date.padEnd(22) +
        (e.entry_type as string).slice(0, 26).padEnd(28) +
        (e.direction as string).padEnd(8) +
        Number(e.amount).toFixed(6).padEnd(12) +
        (e.status as string)
      );
    }
  }
  console.log(`\n${"═".repeat(70)}`);
  console.log(`Total entries: ${(ledger ?? []).length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
