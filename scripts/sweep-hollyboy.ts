import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getMint, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { config } from "../src/config.ts";
import { decryptSecretKey, parseSecretKey } from "../src/solana-wallet.ts";
import { getFantasyWalletByTelegramId } from "../src/db/wallets.ts";
import { debitBalance, getBalance } from "../src/db/balances.ts";

const TELEGRAM_ID = 6545367105;
const LEAVE_AMOUNT = 1.23;
const MEMO = "Offramp Overdraft";

const conn = new Connection(config.SOLANA_RPC_URL, "confirmed");
const mint = new PublicKey(config.SOLANA_USDC_MINT);

async function main() {
  const wallet = await getFantasyWalletByTelegramId(TELEGRAM_ID);
  if (!wallet) throw new Error("Wallet not found.");

  const userAta = new PublicKey(wallet.usdc_ata);
  const bal = await conn.getTokenAccountBalance(userAta, "confirmed");
  const currentRaw = BigInt(bal.value.amount);
  const currentUi = Number(currentRaw) / 1_000_000;

  const sweepUi = Math.round((currentUi - LEAVE_AMOUNT) * 1_000_000) / 1_000_000;
  const sweepRaw = BigInt(Math.round(sweepUi * 1_000_000));

  if (sweepRaw <= 0n) throw new Error(`Balance $${currentUi} is already <= $${LEAVE_AMOUNT}`);

  console.log(`On-chain balance: $${currentUi}`);
  console.log(`Sweeping:         $${sweepUi} (leaving $${LEAVE_AMOUNT})`);

  const raw = config.SOLANA_TREASURY_SECRET_KEY.trim();
  const treasury = Keypair.fromSecretKey(
    raw.startsWith("v1.") ? decryptSecretKey(raw) : parseSecretKey(raw)
  );
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey);
  const mintInfo = await getMint(conn, mint, "confirmed");

  const userKp = Keypair.fromSecretKey(decryptSecretKey(wallet.encrypted_secret_key));
  const tx = new Transaction().add(
    createTransferCheckedInstruction(userAta, mint, treasuryAta, userKp.publicKey, sweepRaw, mintInfo.decimals)
  );
  tx.feePayer = treasury.publicKey;

  const sig = await sendAndConfirmTransaction(conn, tx, [treasury, userKp], { commitment: "confirmed" });
  console.log(`✅ On-chain transfer confirmed: ${sig}`);

  const dbBefore = await getBalance(TELEGRAM_ID);
  const ok = await debitBalance(TELEGRAM_ID, sweepUi, {
    entryType: "admin_sweep",
    referenceType: "sweep",
    referenceId: sig,
    idempotencyKey: `sweep:${sig}`,
    metadata: { memo: MEMO, signature: sig },
  });

  if (!ok) throw new Error("DB debit failed — manual reconciliation needed for sig: " + sig);

  const dbAfter = await getBalance(TELEGRAM_ID);
  console.log(`DB balance: $${dbBefore} → $${dbAfter}`);
  console.log(`Memo: "${MEMO}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });
