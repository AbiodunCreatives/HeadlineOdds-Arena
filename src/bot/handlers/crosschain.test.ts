import { describe, it, expect, vi, beforeEach } from "vitest";
import { InlineKeyboard } from "grammy";

// Mock heavy dependencies before importing the module under test
vi.mock("../../fantasy-league.ts", () => ({
  saveCrossChainSession: vi.fn(),
  loadCrossChainSession: vi.fn(),
  clearCrossChainSession: vi.fn(),
}));
vi.mock("../../dextopus.ts", () => ({ getDextopusTokens: vi.fn(), getDextopusDepositStatus: vi.fn() }));
vi.mock("../../solana-wallet.ts", () => ({ createCrossChainDeposit: vi.fn() }));

import {
  CC_CHAIN_PREFIX,
  CC_TOKEN_PREFIX,
  CC_CONFIRM,
  CC_CANCEL,
  CC_STATUS_PREFIX,
  CHAIN_NAMES,
  buildCrossChainChainPickerKeyboard,
  buildCrossChainTokenPickerKeyboard,
  buildCrossChainDepositAddressText,
  buildCrossChainConfirmText,
  handleCrossChainCallback,
} from "./crosschain.ts";
import { getDextopusTokens } from "../../dextopus.ts";
import { loadCrossChainSession, clearCrossChainSession, saveCrossChainSession } from "../../fantasy-league.ts";

// ── Callback data length ──────────────────────────────────────────────────────

describe("callback data length", () => {
  it("chain picker buttons stay under 64 bytes", () => {
    const chains = Object.entries(CHAIN_NAMES).map(([id, name]) => ({ chainId: id, name }));
    const kb = buildCrossChainChainPickerKeyboard(chains, 0, "wallet:back");
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        if ("callback_data" in btn) {
          expect(btn.callback_data!.length, `"${btn.callback_data}" exceeds 64 bytes`).toBeLessThanOrEqual(64);
        }
      }
    }
  });

  it("token picker buttons stay under 64 bytes", () => {
    const tokens = [
      { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 18 },
      { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC", decimals: 8 },
    ];
    const kb = buildCrossChainTokenPickerKeyboard(tokens, "42161");
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        if ("callback_data" in btn) {
          expect(btn.callback_data!.length, `"${btn.callback_data}" exceeds 64 bytes`).toBeLessThanOrEqual(64);
        }
      }
    }
  });
});

// ── Builder output ────────────────────────────────────────────────────────────

describe("buildCrossChainDepositAddressText", () => {
  it("includes deposit address and symbol", () => {
    const text = buildCrossChainDepositAddressText({
      depositAddress: "0xABC123",
      originSymbol: "USDT",
      expectedUsdcOut: 9.95,
      expiresInSeconds: 600,
    });
    expect(text).toContain("0xABC123");
    expect(text).toContain("USDT");
    expect(text).toContain("10 min");
  });
});

describe("buildCrossChainConfirmText", () => {
  it("shows amount and chain", () => {
    const text = buildCrossChainConfirmText({
      step: "pending_confirm",
      chainId: "42161",
      chainName: "Arbitrum",
      tokenAddress: "0xabc",
      tokenSymbol: "USDT",
      tokenDecimals: 6,
      amount: "50",
    });
    expect(text).toContain("50 USDT");
    expect(text).toContain("Arbitrum");
  });
});

// ── handleCrossChainCallback ──────────────────────────────────────────────────

function makeCtx(telegramId = 123) {
  return { from: { id: telegramId } } as any;
}

describe("handleCrossChainCallback", () => {
  const walletKb = new InlineKeyboard();
  const edit = vi.fn().mockResolvedValue(undefined);
  const renderWallet = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for unrecognised data", async () => {
    const result = await handleCrossChainCallback(
      makeCtx(), "arena:something", edit, walletKb, "wallet:back", "wallet:open", renderWallet,
    );
    expect(result).toBe(false);
    expect(edit).not.toHaveBeenCalled();
  });

  it("CC_CANCEL clears session and renders wallet", async () => {
    vi.mocked(clearCrossChainSession).mockResolvedValue(undefined);
    const result = await handleCrossChainCallback(
      makeCtx(), CC_CANCEL, edit, walletKb, "wallet:back", "wallet:open", renderWallet,
    );
    expect(result).toBe(true);
    expect(clearCrossChainSession).toHaveBeenCalledWith(123);
    expect(renderWallet).toHaveBeenCalled();
  });

  it("CC_CONFIRM with expired session shows error", async () => {
    vi.mocked(loadCrossChainSession).mockResolvedValue(null);
    const result = await handleCrossChainCallback(
      makeCtx(), CC_CONFIRM, edit, walletKb, "wallet:back", "wallet:open", renderWallet,
    );
    expect(result).toBe(true);
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("expired"), walletKb);
  });

  it("CC_CONFIRM with <5min left shows expiry warning", async () => {
    vi.mocked(loadCrossChainSession).mockResolvedValue({
      step: "pending_confirm",
      chainId: "1",
      chainName: "Ethereum",
      tokenAddress: "0xabc",
      tokenSymbol: "USDT",
      tokenDecimals: 6,
      amount: "10",
      expiresAt: Date.now() + 2 * 60 * 1000, // 2 min left
    });
    await handleCrossChainCallback(
      makeCtx(), CC_CONFIRM, edit, walletKb, "wallet:back", "wallet:open", renderWallet,
    );
    expect(edit).toHaveBeenCalledWith(expect.stringContaining("⚠️"), expect.anything());
  });

  it("token picker resolves by index from getDextopusTokens", async () => {
    const tokens = [
      { chainId: 42161, address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6 },
      { chainId: 42161, address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC", decimals: 8 },
    ];
    vi.mocked(getDextopusTokens).mockResolvedValue(tokens as any);
    vi.mocked(saveCrossChainSession).mockResolvedValue(undefined);

    await handleCrossChainCallback(
      makeCtx(), `${CC_TOKEN_PREFIX}42161:1`, edit, walletKb, "wallet:back", "wallet:open", renderWallet,
    );

    expect(saveCrossChainSession).toHaveBeenCalledWith(123, expect.objectContaining({
      tokenSymbol: "WBTC",
      tokenAddress: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f",
    }));
  });
});
