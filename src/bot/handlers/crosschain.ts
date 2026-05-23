import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";

import {
  saveCrossChainSession,
  loadCrossChainSession,
  clearCrossChainSession,
  type CrossChainSession,
} from "../../fantasy-league.ts";
import { getDextopusTokens, getDextopusDepositStatus } from "../../dextopus.ts";
import { createCrossChainDeposit } from "../../solana-wallet.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

export const CC_CHAIN_PREFIX  = "cc:chain:";
export const CC_TOKEN_PREFIX  = "cc:token:";
export const CC_CONFIRM       = "cc:confirm";
export const CC_CANCEL        = "cc:cancel";
export const CC_STATUS_PREFIX = "cc:status:";

export const CHAIN_NAMES: Record<string, string> = {
  "1": "Ethereum",
  "56": "BNB Chain",
  "137": "Polygon",
  "42161": "Arbitrum",
  "10": "Optimism",
  "8453": "Base",
  "43114": "Avalanche",
  "250": "Fantom",
  "100": "Gnosis",
  "1101": "Polygon zkEVM",
  "324": "zkSync Era",
  "59144": "Linea",
  "534352": "Scroll",
  "81457": "Blast",
  "7777777": "Zora",
  "792703809": "Solana",
  "728126428": "Tron",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatUsdc(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  const minimumFractionDigits = Number.isInteger(rounded) ? 0 : 2;
  return `${rounded.toLocaleString("en-US", { minimumFractionDigits, maximumFractionDigits: 6 })} USDC`;
}

// ── Builders ──────────────────────────────────────────────────────────────────

export function buildCrossChainChainPickerText(): string {
  return "🌐 Deposit from Another Chain\n\nSelect the chain you're sending from:";
}

export function buildCrossChainChainPickerKeyboard(
  chains: Array<{ chainId: number | string; name: string }>,
  page: number,
  walletBackData: string
): InlineKeyboard {
  const PAGE_SIZE = 8;
  const start = page * PAGE_SIZE;
  const slice = chains.slice(start, start + PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (let i = 0; i < slice.length; i += 2) {
    for (const c of slice.slice(i, i + 2)) {
      const label = String(c.name).slice(0, 20);
      kb.text(label, `${CC_CHAIN_PREFIX}${c.chainId}:${encodeURIComponent(label)}`);
    }
    kb.row();
  }
  if (page > 0 || start + PAGE_SIZE < chains.length) {
    if (page > 0) kb.text("◀ Prev", `cc:chains:page:${page - 1}`);
    if (start + PAGE_SIZE < chains.length) kb.text("Next ▶", `cc:chains:page:${page + 1}`);
    kb.row();
  }
  kb.text("← Back", walletBackData);
  return kb;
}

export function buildCrossChainTokenPickerKeyboard(
  tokens: Array<{ address: string; symbol: string; decimals: number }>,
  chainId: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const limit = Math.min(tokens.length, 16);
  for (let i = 0; i < limit; i += 3) {
    for (let j = i; j < Math.min(i + 3, limit); j++) {
      kb.text(tokens[j].symbol, `${CC_TOKEN_PREFIX}${chainId}:${j}`);
    }
    kb.row();
  }
  kb.text("← Back", `cc:chains:page:0`);
  return kb;
}

export function buildCrossChainAmountPromptKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("❌ Cancel", CC_CANCEL);
}

export function buildCrossChainConfirmText(session: CrossChainSession): string {
  return [
    "🌐 Confirm Cross-Chain Deposit",
    "",
    `Sending:  ${session.amount} ${session.tokenSymbol}`,
    `Chain:    ${session.chainName}`,
    "",
    "A deposit address will be generated. Send exactly this amount to it.",
    "USDC arrives in your in-bot wallet automatically after confirmation.",
  ].join("\n");
}

export function buildCrossChainConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Get deposit address", CC_CONFIRM)
    .text("❌ Cancel", CC_CANCEL);
}

export function buildCrossChainDepositAddressText(input: {
  depositAddress: string;
  originSymbol: string;
  expectedUsdcOut: number;
  expiresInSeconds: number;
}): string {
  return [
    "<b>CROSS-CHAIN DEPOSIT</b>",
    "",
    `Send your ${input.originSymbol} to`,
    `<code>${input.depositAddress}</code>`,
    "",
    `Expected credit  <code>~${formatUsdc(input.expectedUsdcOut)}</code>`,
    `Expires in       ${Math.round(input.expiresInSeconds / 60)} min`,
    "",
    "USDC arrives automatically once your transaction confirms.",
  ].join("\n");
}

export function buildCrossChainDepositAddressKeyboard(
  depositRequestId: string,
  walletOpenData: string,
  walletBackData: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔄 Check status", `${CC_STATUS_PREFIX}${depositRequestId}`)
    .row()
    .text("💳 Wallet", walletOpenData)
    .text("🏟 Arenas", walletBackData);
}

export function buildCrossChainStatusText(input: {
  status: string;
  executionStatus: string;
  originTxs: string[];
  destTxs: string[];
}): string {
  const emoji: Record<string, string> = {
    pending: "⏳", processing: "🔄", completed: "✅", expired: "❌", failed: "❌",
  };
  const lines = [
    `${emoji[input.status.toLowerCase()] ?? "ℹ️"} Status: ${input.status}`,
    `Execution: ${input.executionStatus}`,
  ];
  if (input.originTxs[0]) lines.push(`Origin tx: ${input.originTxs[0]}`);
  if (input.destTxs[0]) lines.push(`Dest tx: ${input.destTxs[0]}`);
  return lines.join("\n");
}

// ── Handler ───────────────────────────────────────────────────────────────────

type EditFn = (text: string, kb?: InlineKeyboard) => Promise<void>;
type WalletViewFn = (ctx: Context, telegramId: number, opts?: { refresh: boolean }) => Promise<void>;

export async function handleCrossChainCallback(
  ctx: Context,
  data: string,
  edit: EditFn,
  walletKeyboard: InlineKeyboard,
  walletBackData: string,
  walletOpenData: string,
  renderWalletView: WalletViewFn,
): Promise<boolean> {
  if (data === "wallet:cross") {
    await clearCrossChainSession(ctx.from!.id);
    try {
      const tokens = await getDextopusTokens();
      const chainMap = new Map<string, { chainId: number | string; name: string }>();
      for (const t of tokens) {
        const key = String(t.chainId);
        if (!chainMap.has(key)) chainMap.set(key, { chainId: t.chainId, name: CHAIN_NAMES[key] ?? key });
      }
      await edit(buildCrossChainChainPickerText(), buildCrossChainChainPickerKeyboard(Array.from(chainMap.values()), 0, walletBackData));
    } catch {
      await edit("Failed to load chains. Please try again.", walletKeyboard);
    }
    return true;
  }

  if (data.startsWith("cc:chains:page:")) {
    const page = parseInt(data.replace("cc:chains:page:", ""), 10) || 0;
    try {
      const tokens = await getDextopusTokens();
      const chainMap = new Map<string, { chainId: number | string; name: string }>();
      for (const t of tokens) {
        const key = String(t.chainId);
        if (!chainMap.has(key)) chainMap.set(key, { chainId: t.chainId, name: CHAIN_NAMES[key] ?? key });
      }
      await edit(buildCrossChainChainPickerText(), buildCrossChainChainPickerKeyboard(Array.from(chainMap.values()), page, walletBackData));
    } catch {
      await edit("Failed to load chains. Please try again.", walletKeyboard);
    }
    return true;
  }

  if (data.startsWith(CC_CHAIN_PREFIX)) {
    const parts = data.slice(CC_CHAIN_PREFIX.length).split(":");
    const chainId = parts[0] ?? "";
    const chainName = decodeURIComponent(parts[1] ?? chainId);
    try {
      const tokens = await getDextopusTokens();
      const chainTokens = tokens.filter((t) => String(t.chainId) === chainId);
      if (chainTokens.length === 0) {
        await edit("No tokens available for this chain.", buildCrossChainChainPickerKeyboard([], 0, walletBackData));
        return true;
      }
      await edit(
        `🌐 Select Token — ${chainName}\n\nWhich token are you sending?`,
        buildCrossChainTokenPickerKeyboard(chainTokens, chainId),
      );
    } catch {
      await edit("Failed to load tokens. Please try again.", walletKeyboard);
    }
    return true;
  }

  if (data.startsWith(CC_TOKEN_PREFIX)) {
    const [chainId, indexStr] = data.slice(CC_TOKEN_PREFIX.length).split(":");
    if (!chainId || indexStr === undefined) return true;
    const tokenIndex = parseInt(indexStr, 10);
    const allTokens = await getDextopusTokens();
    const chainTokens = allTokens.filter((t) => String(t.chainId) === chainId);
    const token = chainTokens[tokenIndex];
    if (!token) {
      await edit("Token not found. Please try again.", walletKeyboard);
      return true;
    }
    await saveCrossChainSession(ctx.from!.id, {
      step: "awaiting_amount",
      chainId,
      chainName: CHAIN_NAMES[chainId] ?? chainId,
      tokenAddress: token.address,
      tokenSymbol: token.symbol,
      tokenDecimals: token.decimals,
    });
    await edit(
      `🌐 How much ${token.symbol} are you sending?\n\nType the amount, e.g. 10`,
      buildCrossChainAmountPromptKeyboard(),
    );
    return true;
  }

  if (data === CC_CONFIRM) {
    const session = await loadCrossChainSession(ctx.from!.id);
    if (!session || session.step !== "pending_confirm" || !session.amount) {
      await edit("Session expired. Please start again.", walletKeyboard);
      return true;
    }
    // Warn if < 5 min remaining
    if (session.expiresAt && session.expiresAt - Date.now() < 5 * 60 * 1000) {
      const minsLeft = Math.max(1, Math.round((session.expiresAt - Date.now()) / 60_000));
      await edit(
        `⚠️ Your session expires in ~${minsLeft} min. Confirm now or it will reset.\n\n` +
        buildCrossChainConfirmText(session),
        buildCrossChainConfirmKeyboard(),
      );
      return true;
    }
    try {
      const amountRaw = BigInt(Math.round(Number(session.amount) * 10 ** session.tokenDecimals)).toString();
      const result = await createCrossChainDeposit({
        telegramId: ctx.from!.id,
        originChainId: session.chainId,
        originAsset: session.tokenAddress,
        originSymbol: session.tokenSymbol,
        amountRaw,
      });
      await clearCrossChainSession(ctx.from!.id);
      await edit(
        buildCrossChainDepositAddressText({
          depositAddress: result.depositAddress,
          originSymbol: session.tokenSymbol,
          expectedUsdcOut: result.expectedUsdcOut,
          expiresInSeconds: result.expiresInSeconds,
        }),
        buildCrossChainDepositAddressKeyboard(result.depositRequestId, walletOpenData, walletBackData),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      await edit(`Cross-chain deposit failed: ${msg}`, walletKeyboard);
    }
    return true;
  }

  if (data === CC_CANCEL) {
    await clearCrossChainSession(ctx.from!.id);
    await renderWalletView(ctx, ctx.from!.id, { refresh: false });
    return true;
  }

  if (data.startsWith(CC_STATUS_PREFIX)) {
    const depositRequestId = data.slice(CC_STATUS_PREFIX.length);
    try {
      const status = await getDextopusDepositStatus(depositRequestId);
      await edit(
        buildCrossChainStatusText({
          status: status.status,
          executionStatus: status.executionStatus,
          originTxs: status.originTransactionHashes,
          destTxs: status.destinationTransactionHashes,
        }),
        buildCrossChainDepositAddressKeyboard(depositRequestId, walletOpenData, walletBackData),
      );
    } catch {
      await edit("Could not fetch deposit status. Please try again.", buildCrossChainDepositAddressKeyboard(depositRequestId, walletOpenData, walletBackData));
    }
    return true;
  }

  return false;
}
