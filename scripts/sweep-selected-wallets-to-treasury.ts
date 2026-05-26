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
import {
  getFantasyWalletByTelegramId,
  updateFantasyWalletObservedBalance,
} from "../src/db/wallets.ts";
import { decryptSecretKey, parseSecretKey } from "../src/solana-wallet.ts";

type SweepTarget = {
  label: string;
  telegramId: number;
  expectedUsername: string;
  expectedOwnerAddress: string;
  expectedUsdcAta: string;
};

type FantasyUserRow = {
  telegram_id: number;
  username: string | null;
  wallet_balance: number | string | null;
};

const TARGETS: SweepTarget[] = [
  {
    label: "alex",
    telegramId: 1285765297,
    expectedUsername: "CallMi_Alex",
    expectedOwnerAddress: "FkCR8ci5aRG5G27pz8kmBX6swC5Doc398dupnaTLQD5d",
    expectedUsdcAta: "9uiJbGngAkbfxWiJKo14t8GaDFvaZH6NY2SfmphTdwKf",
  },
  {
    label: "hollyboy",
    telegramId: 6545367105,
    expectedUsername: "hollyboysol",
    expectedOwnerAddress: "5BkpYnFuFgczSwZqvCBwLB9gbRR5TW1Vebz9pzxMBdYK",
    expectedUsdcAta: "B4nFMGDDFnvXGtX5sn7Fm3mQ76ZaVrDAsg4dhcv1g58b",
  },
  {
    label: "gpee",
    telegramId: 6898924363,
    expectedUsername: "GpeeEtuk",
    expectedOwnerAddress: "9WsPdDDeHxreS9Ccpo2ehQS4uanbUmEno1iMdPooKVU2",
    expectedUsdcAta: "HFqTkMoBVHVWmo7dHAa2AbKZWp5UZ6JJ7UYs63D9kgCg",
  },
  {
    label: "josephwebdev",
    telegramId: 5885250606,
    expectedUsername: "josephwebdev",
    expectedOwnerAddress: "FLGBEwB6ufqRaxqgfGsYq5E3wfKYCH3NXJTT9nHrsogg",
    expectedUsdcAta: "6HMvUb4nj3AooCVLnojiwEHp5rBF6Z7X2zws8m1BGhSd",
  },
  {
    label: "horlarwealthy",
    telegramId: 6647078120,
    expectedUsername: "HORLARWEALTHY",
    expectedOwnerAddress: "FKuz7vVLJVajmC2nxaez2QLEprnsrZ2raAQFncB5MqMb",
    expectedUsdcAta: "BBFgYKjXY8QZncNEVy1n6dHAHzpQsZ5DzDZjimA5TUa7",
  },
];

const EXECUTE = process.argv.includes("--execute");
const ONLY_LABELS = new Set(
  process.argv
    .find((arg) => arg.startsWith("--only="))
    ?.slice("--only=".length)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean) ?? []
);
const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
const mint = new PublicKey(config.SOLANA_USDC_MINT);

function roundUsdc(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function rawToUsdc(amountRaw: bigint): number {
  return roundUsdc(Number(amountRaw) / 1_000_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableSupabaseNetworkError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as Record<string, unknown>;
  const combined = [record["message"], record["details"]]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return (
    combined.includes("fetch failed") ||
    combined.includes("connect timeout") ||
    combined.includes("etimedout") ||
    combined.includes("socket hang up")
  );
}

async function withRetries<T>(
  label: string,
  action: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastError: unknown;

  for (let index = 0; index < attempts; index += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;

      if (!isRetryableSupabaseNetworkError(error) || index === attempts - 1) {
        throw error;
      }

      const waitMs = 1500 * (index + 1);
      console.warn(
        `[${label}] transient Supabase/network error, retrying in ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }

  throw lastError;
}

function loadTreasury(): Keypair {
  const raw = config.SOLANA_TREASURY_SECRET_KEY.trim();
  return Keypair.fromSecretKey(
    raw.startsWith("v1.") ? decryptSecretKey(raw) : parseSecretKey(raw)
  );
}

async function ensureAssociatedTokenAccount(
  owner: PublicKey,
  payer: Keypair
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner);
  const existing = await connection.getAccountInfo(ata, "confirmed");

  if (existing) {
    return ata;
  }

  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      ata,
      owner,
      mint
    )
  );

  await sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });

  return ata;
}

async function getRawBalance(address: PublicKey): Promise<bigint> {
  try {
    const balance = await connection.getTokenAccountBalance(address, "confirmed");
    return BigInt(balance.value.amount);
  } catch (error) {
    const message =
      error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

    if (
      message.includes("could not find account") ||
      message.includes("failed to find account") ||
      message.includes("invalid param")
    ) {
      return 0n;
    }

    throw error;
  }
}

async function getUserRow(telegramId: number): Promise<FantasyUserRow | null> {
  const { data, error } = await withRetries(
    `user:${telegramId}`,
    () =>
      supabase
        .from("fantasy_users")
        .select("telegram_id, username, wallet_balance")
        .eq("telegram_id", telegramId)
        .maybeSingle()
  );

  if (error) {
    throw error;
  }

  return (data as FantasyUserRow | null) ?? null;
}

function assertMatchesExpected(target: SweepTarget, user: FantasyUserRow, wallet: {
  owner_address: string;
  usdc_ata: string;
}): void {
  if ((user.username ?? "") !== target.expectedUsername) {
    throw new Error(
      `[${target.label}] Username mismatch. Expected ${target.expectedUsername}, got ${user.username ?? "(null)"}`
    );
  }

  if (wallet.owner_address !== target.expectedOwnerAddress) {
    throw new Error(
      `[${target.label}] Owner address mismatch. Expected ${target.expectedOwnerAddress}, got ${wallet.owner_address}`
    );
  }

  if (wallet.usdc_ata !== target.expectedUsdcAta) {
    throw new Error(
      `[${target.label}] USDC ATA mismatch. Expected ${target.expectedUsdcAta}, got ${wallet.usdc_ata}`
    );
  }
}

async function sweepTarget(target: SweepTarget, treasury: Keypair): Promise<{
  label: string;
  sweptRaw: bigint;
  sweptUi: number;
  signature: string | null;
  warning: string | null;
}> {
  const [user, wallet, mintInfo] = await Promise.all([
    getUserRow(target.telegramId),
    withRetries(`wallet:${target.label}`, () =>
      getFantasyWalletByTelegramId(target.telegramId)
    ),
    getMint(connection, mint, "confirmed"),
  ]);

  if (!user) {
    throw new Error(`[${target.label}] User row not found.`);
  }

  if (!wallet) {
    throw new Error(`[${target.label}] Wallet row not found.`);
  }

  assertMatchesExpected(target, user, wallet);

  const userAta = new PublicKey(wallet.usdc_ata);
  const treasuryAta = await ensureAssociatedTokenAccount(treasury.publicKey, treasury);
  const liveRaw = await getRawBalance(userAta);
  const liveUi = rawToUsdc(liveRaw);
  const internalBalance = roundUsdc(Number(user.wallet_balance ?? 0));

  console.log(
    [
      `[${target.label}] @${user.username ?? "unknown"} (${target.telegramId})`,
      `  owner:    ${wallet.owner_address}`,
      `  user ATA: ${wallet.usdc_ata}`,
      `  internal: ${internalBalance.toFixed(6)} USDC`,
      `  observed: ${rawToUsdc(wallet.last_seen_usdc_balance_raw).toFixed(6)} USDC`,
      `  live:     ${liveUi.toFixed(6)} USDC`,
    ].join("\n")
  );

  if (liveRaw <= 0n) {
    if (wallet.last_seen_usdc_balance_raw !== 0n && EXECUTE) {
      await updateFantasyWalletObservedBalance({
        telegramId: target.telegramId,
        rawBalance: 0n,
      });
      console.log("  synced cached observed balance to 0.000000 USDC");
    }

    console.log("  skipped: no live on-chain USDC to sweep\n");
    return {
      label: target.label,
      sweptRaw: 0n,
      sweptUi: 0,
      signature: null,
      warning: null,
    };
  }

  if (!EXECUTE) {
    console.log("  dry-run: add --execute to broadcast the sweep\n");
    return {
      label: target.label,
      sweptRaw: liveRaw,
      sweptUi: liveUi,
      signature: null,
      warning: null,
    };
  }

  const userKeypair = Keypair.fromSecretKey(decryptSecretKey(wallet.encrypted_secret_key));
  const tx = new Transaction().add(
    createTransferCheckedInstruction(
      userAta,
      mint,
      treasuryAta,
      userKeypair.publicKey,
      liveRaw,
      mintInfo.decimals
    )
  );
  tx.feePayer = treasury.publicKey;

  const signature = await sendAndConfirmTransaction(
    connection,
    tx,
    [treasury, userKeypair],
    {
      commitment: "confirmed",
    }
  );

  const remainingRaw = await getRawBalance(userAta);
  console.log(`  swept: ${liveUi.toFixed(6)} USDC`);
  console.log(`  sig:   ${signature}`);

  let warning: string | null = null;

  try {
    await withRetries(`sync:${target.label}`, () =>
      updateFantasyWalletObservedBalance({
        telegramId: target.telegramId,
        rawBalance: remainingRaw,
      })
    );
    console.log(`  left:  ${rawToUsdc(remainingRaw).toFixed(6)} USDC\n`);
  } catch (error) {
    warning =
      `[${target.label}] sweep succeeded on-chain with signature ${signature}, ` +
      `but syncing last_seen_usdc_balance_raw failed: ` +
      `${error instanceof Error ? error.message : String(error)}`;
    console.warn(`  warning: ${warning}\n`);
  }

  return {
    label: target.label,
    sweptRaw: liveRaw,
    sweptUi: liveUi,
    signature,
    warning,
  };
}

async function main(): Promise<void> {
  const treasury = loadTreasury();
  const selectedTargets =
    ONLY_LABELS.size === 0
      ? TARGETS
      : TARGETS.filter((target) => ONLY_LABELS.has(target.label.toLowerCase()));

  if (selectedTargets.length === 0) {
    throw new Error(
      `No targets matched --only=${Array.from(ONLY_LABELS).join(",") || "(empty)"}.`
    );
  }

  console.log(`Treasury wallet: ${treasury.publicKey.toBase58()}`);
  console.log(`Mode: ${EXECUTE ? "EXECUTE" : "DRY RUN"}\n`);

  const results = [];
  for (const target of selectedTargets) {
    const result = await sweepTarget(target, treasury);
    results.push(result);
  }

  const totalSwept = results.reduce((sum, item) => sum + item.sweptUi, 0);
  const completed = results.filter((item) => item.signature).length;
  const warnings = results
    .map((item) => item.warning)
    .filter((warning): warning is string => Boolean(warning));

  console.log("Summary");
  console.log("-------");
  console.log(`Targets:     ${selectedTargets.length}`);
  console.log(`Sweep total: ${totalSwept.toFixed(6)} USDC`);
  console.log(`Broadcasts:  ${completed}`);

  if (warnings.length > 0) {
    console.log("\nWarnings");
    console.log("--------");
    for (const warning of warnings) {
      console.log(warning);
    }
  }

  if (!EXECUTE) {
    console.log("\nNo transactions were sent. Re-run with --execute when ready.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
