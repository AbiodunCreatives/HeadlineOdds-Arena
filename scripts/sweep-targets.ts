import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getMint } from "@solana/spl-token";
import { config } from "../src/config.ts";
import { decryptSecretKey, parseSecretKey } from "../src/solana-wallet.ts";
import { getFantasyWalletByTelegramId } from "../src/db/wallets.ts";
import { creditBalance } from "../src/db/balances.ts";
import { sendAndConfirmTransaction } from "@solana/web3.js";

const TARGET_IDS = [6545367105, 6647078120];
const MEMO = "arena entry recovery";

const conn = new Connection(config.SOLANA_RPC_URL, "confirmed");
const mint = new PublicKey(config.SOLANA_USDC_MINT);

function loadTreasury(): Keypair {
  const raw = config.SOLANA_TREASURY_SECRET_KEY.trim();
  return Keypair.fromSecretKey(
    raw.startsWith("v1.") ? decryptSecretKey(raw) : parseSecretKey(raw)
  );
}

async function main() {
  const treasury = loadTreasury();
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury.publicKey);
  const mintInfo = await getMint(conn, mint, "confirmed");

  console.log(`Treasury: ${treasury.publicKey.toBase58()}`);
  console.log(`Memo: "${MEMO}"\n`);

  for (const telegramId of TARGET_IDS) {
    const wallet = await getFantasyWalletByTelegramId(telegramId);
    if (!wallet) {
      console.log(`${telegramId}: wallet not found, skipping.`);
      continue;
    }

    const userAta = new PublicKey(wallet.usdc_ata);
    let rawAmount: bigint;
    let uiAmount: number;

    try {
      const bal = await conn.getTokenAccountBalance(userAta, "confirmed");
      rawAmount = BigInt(bal.value.amount);
      uiAmount = bal.value.uiAmount ?? 0;
    } catch {
      console.log(`${telegramId}: ATA not found, skipping.`);
      continue;
    }

    if (rawAmount === 0n) {
      console.log(`${telegramId}: zero balance, skipping.`);
      continue;
    }

    console.log(`${telegramId} (${wallet.owner_address}): ${uiAmount} USDC — sweeping...`);

    try {
      const userKp = Keypair.fromSecretKey(decryptSecretKey(wallet.encrypted_secret_key));
      const tx = new Transaction().add(
        createTransferCheckedInstruction(
          userAta, mint, treasuryAta, userKp.publicKey, rawAmount, mintInfo.decimals
        )
      );
      tx.feePayer = treasury.publicKey;

      const sig = await sendAndConfirmTransaction(conn, tx, [treasury, userKp], {
        commitment: "confirmed",
      });

      await creditBalance(telegramId, uiAmount, {
        entryType: "arena_entry_recovery",
        referenceType: "sweep",
        referenceId: sig,
        idempotencyKey: `sweep:${sig}`,
        metadata: { memo: MEMO, signature: sig },
      });

      console.log(`  ✅ Swept ${uiAmount} USDC — sig: ${sig}`);
    } catch (err) {
      console.error(`  ❌ Failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
