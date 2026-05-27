/**
 * Print all users' on-chain USDC balances and sweep wallets with >= 0.50 USDC to treasury.
 *
 * Usage:
 *   pnpm tsx scripts/sweep-low-balance-to-treasury.ts            # dry-run
 *   pnpm tsx scripts/sweep-low-balance-to-treasury.ts --execute  # broadcast
 */

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

import { config } from "../src/config.ts";
import { supabase } from "../src/db/client.ts";
import { listFantasyWallets, updateFantasyWalletObservedBalance } from "../src/db/wallets.ts";
import { decryptSecretKey, parseSecretKey } from "../src/solana-wallet.ts";

const SWEEP_THRESHOLD_USDC = 0.50;
const EXECUTE = process.argv.includes("--execute");

const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
const mint = new PublicKey(config.SOLANA_USDC_MINT);

function rawToUsdc(raw: bigint): number {
  return Number(raw) / 1_000_000;
}

async function getRawBalance(ata: PublicKey): Promise<bigint> {
  try {
    const bal = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

function loadTreasury(): Keypair {
  const raw = config.SOLANA_TREASURY_SECRET_KEY.trim();
  return Keypair.fromSecretKey(
    raw.startsWith("v1.") ? decryptSecretKey(raw) : parseSecretKey(raw)
  );
}

async function ensureTreasuryAta(treasury: Keypair): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, treasury.publicKey);
  const existing = await connection.getAccountInfo(ata, "confirmed");
  if (!existing) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        treasury.publicKey, ata, treasury.publicKey, mint
      )
    );
    await sendAndConfirmTransaction(connection, tx, [treasury], { commitment: "confirmed" });
  }
  return ata;
}

async function main(): Promise<void> {
  const treasury = loadTreasury();
  console.log(`Treasury: ${treasury.publicKey.toBase58()}`);
  console.log(`Mode:     ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  console.log(`Threshold: >= ${SWEEP_THRESHOLD_USDC} USDC\n`);

  // Fetch all wallets and usernames in parallel
  const [wallets, { data: users }] = await Promise.all([
    listFantasyWallets(),
    supabase.from("fantasy_users").select("telegram_id, username"),
  ]);

  const usernameMap = new Map<number, string>(
    (users ?? []).map((u) => [Number(u.telegram_id), (u.username as string | null) ?? "—"])
  );

  // Fetch all on-chain balances in parallel
  const rows = await Promise.all(
    wallets.map(async (w) => {
      const raw = await getRawBalance(new PublicKey(w.usdc_ata));
      return {
        telegram_id: w.telegram_id,
        username: usernameMap.get(w.telegram_id) ?? "—",
        usdc_ata: w.usdc_ata,
        encrypted_secret_key: w.encrypted_secret_key,
        raw,
        ui: rawToUsdc(raw),
      };
    })
  );

  rows.sort((a, b) => b.ui - a.ui);

  // Print balance table
  const W = 90;
  console.log("On-Chain USDC Balances");
  console.log("=".repeat(W));
  console.log(
    "telegram_id".padEnd(16) +
    "username".padEnd(22) +
    "on_chain_usdc".padEnd(18) +
    "usdc_ata"
  );
  console.log("-".repeat(W));
  for (const r of rows) {
    console.log(
      String(r.telegram_id).padEnd(16) +
      r.username.padEnd(22) +
      r.ui.toFixed(6).padEnd(18) +
      r.usdc_ata
    );
  }
  const total = rows.reduce((s, r) => s + r.ui, 0);
  console.log("-".repeat(W));
  console.log(`${"TOTAL".padEnd(38)}${total.toFixed(6)} USDC`);
  console.log(`\n${rows.length} wallet(s) queried.\n`);

  // Identify sweep targets
  const targets = rows.filter((r) => r.ui >= SWEEP_THRESHOLD_USDC);
  if (targets.length === 0) {
    console.log(`No wallets with >= ${SWEEP_THRESHOLD_USDC} USDC found. Nothing to sweep.`);
    return;
  }

  console.log(`\nSweep targets (${targets.length}):`);
  console.log("-".repeat(W));

  const mintInfo = await getMint(connection, mint, "confirmed");
  const treasuryAta = await ensureTreasuryAta(treasury);

  let totalSwept = 0;
  let broadcasts = 0;

  for (const t of targets) {
    const userAta = new PublicKey(t.usdc_ata);
    console.log(`@${t.username} (${t.telegram_id}) — ${t.ui.toFixed(6)} USDC`);

    if (!EXECUTE) {
      console.log(`  dry-run: would sweep ${t.ui.toFixed(6)} USDC\n`);
      totalSwept += t.ui;
      continue;
    }

    try {
      const userKeypair = Keypair.fromSecretKey(decryptSecretKey(t.encrypted_secret_key));
      const tx = new Transaction().add(
        createTransferCheckedInstruction(
          userAta, mint, treasuryAta,
          userKeypair.publicKey,
          t.raw, mintInfo.decimals
        )
      );
      tx.feePayer = treasury.publicKey;

      const sig = await sendAndConfirmTransaction(connection, tx, [treasury, userKeypair], {
        commitment: "confirmed",
      });

      console.log(`  swept:  ${t.ui.toFixed(6)} USDC`);
      console.log(`  sig:    ${sig}`);
      totalSwept += t.ui;
      broadcasts++;

      // Sync observed balance
      try {
        await updateFantasyWalletObservedBalance({ telegramId: t.telegram_id, rawBalance: 0n });
        console.log(`  synced observed balance to 0\n`);
      } catch (e) {
        console.warn(`  warning: sweep succeeded but failed to sync observed balance: ${e}\n`);
      }
    } catch (e) {
      console.error(`  error sweeping @${t.username}: ${e}\n`);
    }
  }

  console.log("Summary");
  console.log("-------");
  console.log(`Targets:    ${targets.length}`);
  console.log(`Swept:      ${totalSwept.toFixed(6)} USDC`);
  if (EXECUTE) console.log(`Broadcasts: ${broadcasts}`);
  if (!EXECUTE) console.log("\nDry run — re-run with --execute to broadcast.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
