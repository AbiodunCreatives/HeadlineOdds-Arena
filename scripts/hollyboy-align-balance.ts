import { supabase } from "../src/db/client.ts";
import { getBalance, debitBalance } from "../src/db/balances.ts";

const TELEGRAM_ID = 6545367105;
const TARGET = 1.23;

async function main() {
  const current = await getBalance(TELEGRAM_ID);
  const diff = Math.round((current - TARGET) * 1_000_000) / 1_000_000;

  console.log(`Current DB balance: $${current}`);
  console.log(`Target:             $${TARGET}`);
  console.log(`Adjustment:         -$${diff}`);

  if (diff <= 0) { console.log("Already at or below target."); return; }

  const ok = await debitBalance(TELEGRAM_ID, diff, {
    entryType: "admin_balance_correction",
    referenceType: "correction",
    idempotencyKey: `balance-correction:hollyboy:${TARGET}:${Date.now()}`,
    metadata: { memo: "Offramp Overdraft", reason: "align db balance to onchain after sweep" },
  });

  if (!ok) throw new Error("Debit failed.");

  const after = await getBalance(TELEGRAM_ID);
  console.log(`DB balance after: $${after}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
