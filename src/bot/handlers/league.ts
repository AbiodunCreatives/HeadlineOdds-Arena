import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { PublicKey } from "@solana/web3.js";

import { getCurrentRoundSnapshot } from "../../bayse-market.ts";
import { getBtcChartMenuUrl } from "../../btc-chart-menu.ts";
import { config } from "../../config.ts";
import { getBalance, debitBalance, creditBalance } from "../../db/balances.ts";
import {
  listBayseEvents,
  placeBayseOrder,
  sharesForAmount,
  potentialPayoutNgn,
  ngnToUsdc,
  type BayseEvent,
  type BayseMarket,
} from "../../bayse-trading.ts";
import { insertBaysePosition } from "../../bayse-settlement.ts";
import { supabase } from "../../db/client.ts";
import { redis } from "../../utils/rateLimit.ts";
import {
  buildMarketText,
  calcOdds,
  createMarket,
  formatOdds,
  getMarket,
  getUserBet,
  listAllUsers,
  placeBet,
  resolveMarket,
  saveBroadcastMessageIds,
} from "../../prediction-market.ts";
import {
  savePendingMarketBet,
  loadPendingMarketBet,
  clearPendingMarketBet,
  savePendingMarketBetCustom,
  hasPendingMarketBetCustom,
  clearPendingMarketBetCustom,
} from "../../fantasy-state.ts";

const NGN_PER_USD = 1600;
import {
  buildFantasyTradeStakeSelection,
  clearPendingFantasyCustomFundAmount,
  clearFantasyTradePromptState,
  resetFantasyTradePromptToDirection,
  clearPendingFantasyLeagueJoin,
  createFantasyLeagueGame,
  getFantasyLeagueStatusView,
  getFantasyLeagueBoardText,
  hasPendingFantasyCustomFundAmount,
  hasPendingCustomArenaFee,
  savePendingCustomArenaFee,
  clearPendingCustomArenaFee,
  getFantasyLeagueDetailsByCode,
  getFantasyLeagueJoinPreview,
  joinFantasyLeagueGame,
  listFantasyArenaLobby,
  listFantasyLeagueSnapshots,
  loadPendingFantasyLeagueJoin,
  placeFantasyTradeFromCallbackData,
  prepareFantasyTradePromptForArena,
  registerFantasyTradePromptDelivery,
  saveFantasyNextRoundReminder,
  savePendingFantasyCustomFundAmount,
  savePendingFantasyLeagueJoin,
  saveOfframpSession,
  loadOfframpSession,
  clearOfframpSession,
  saveWithdrawState,
  loadWithdrawState,
  clearWithdrawState,
  savePendingJoinCodeEntry,
  hasPendingJoinCodeEntry,
  clearPendingJoinCodeEntry,
  saveCrossChainSession,
  loadCrossChainSession,
  clearCrossChainSession,
  type CrossChainSession,
  FANTASY_MIN_ENTRY_FEE,
  createFreeTrialArena,
  hasUsedFreeTrial,
  createAgentArena,
  joinAgentArena,
  AGENT_STYLES,
  AGENT_DISPLAY_NAMES,
  type AgentStyle,
  type FantasyTradePlacementResult,
  type OfframpSessionState,
} from "../../fantasy-league.ts";
import {
  ARENA_DURATION_HOURS_OPTIONS,
  ARENA_ENTRY_FEE_OPTIONS,
  anonymizePlayer,
  buildShareInviteUrl,
  formatBtcPrice,
  formatDurationHours,
  formatCompactDuration,
  formatProbabilityPrice,
  formatSignedPercent,
  formatWholeMoney,
  formatRoundCountdown,
  getGameDurationHours,
  getGameRoundNumber,
  getApproxRoundsUntil,
  getRoundsForDurationHours,
} from "../../fantasy-ui.ts";
import {
  getFantasyWalletSummary,
  processFantasyWalletWithdrawals,
  requestFantasyWalletWithdrawal,
  syncFantasyWalletDeposits,
  transferTreasuryUsdc,
  createCrossChainDeposit,
} from "../../solana-wallet.ts";
import { createFantasyPajCashOnramp, getBanks, confirmBankAccount, createFantasyPajCashOfframp, PAJCASH_OFFRAMP_MIN_USDC } from "../../pajcash.ts";
import { getDextopusTokens, getDextopusDepositStatus } from "../../dextopus.ts";
import {
  handleCrossChainCallback,
  buildCrossChainAmountPromptKeyboard,
  buildCrossChainConfirmText,
  buildCrossChainConfirmKeyboard,
} from "./crosschain.ts";
import { isDevUser } from "../../utils/devOverrides.ts";
import { handleSupportQuestion } from "./support.ts";

const START_HOW_IT_WORKS = "start:how";
const START_LOBBY = "start:lobby";
const START_WALLET = "start:wallet";
const LOBBY_REFRESH = "lobby:refresh";
const LOBBY_LIVE = "lobby:live";
const ARENA_CREATE = "arena:create";
const ARENA_DURATION_PREFIX = "arena:duration:";
const ARENA_AGENT_PREFIX = "arena:agent:";
const ARENA_BACK_TO_LOBBY = "arena:lobby";
const ARENA_LIVE_PREFIX = "arena:live:";
const ARENA_TRADE_PREFIX = "arena:trade:";
const ARENA_REFRESH_PREFIX = "arena:refresh:";
const ARENA_CATCH_UP_PREFIX = "arena:catch:";
const ARENA_REMIND_PREFIX = "arena:remind:";
const ARENA_JOIN_CONFIRM = "fantasy:join:confirm";
const ARENA_JOIN_DECLINE = "fantasy:join:decline";
const FUNDS_ADD = "funds:add";
const FUNDS_CUSTOM = "funds:custom";
const FUNDS_BACK_TO_LOBBY = "funds:lobby";
const WALLET_OPEN = "wallet:open";
const WALLET_REFRESH = "wallet:refresh";
const WALLET_NAIRA_HELP = "wallet:naira";
const WALLET_NAIRA_AMOUNT_PREFIX = "wallet:naira:amount:";
const WALLET_NAIRA_CUSTOM = "wallet:naira:custom";
const WALLET_NAIRA_BACK = "wallet:naira:back";
const WALLET_WITHDRAW_HELP = "wallet:withdraw";
const WALLET_BACK = "wallet:back";
const WALLET_CROSS_CHAIN = "wallet:cross";
const ARENA_CREATE_CUSTOM = "arena:create:custom";
const ARENA_FREE_TRIAL = "arena:free_trial";
const WALLET_NAIRA_MIN_AMOUNT = 1_000;

const WALLET_NAIRA_MAX_AMOUNT = 20_000;
const WALLET_NAIRA_PRESET_AMOUNTS = [1_000, 2_000, 5_000, 10_000] as const;

const OFFRAMP_CANCEL = "offramp:cancel";
const OFFRAMP_CONFIRM = "offramp:confirm";

type FantasyLeagueStatusViewData = Awaited<
  ReturnType<typeof getFantasyLeagueStatusView>
>;
type ArenaCurrentRoundSnapshot = Awaited<ReturnType<typeof getCurrentRoundSnapshot>>;

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Wrap a value in an HTML code span for tap-to-copy */
function c(value: string | number): string {
  return `<code>${escapeHtml(String(value))}</code>`;
}

function formatMoney(
  value: number,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }
): string {
  return `$${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2,
  })}`;
}

function formatUsdc(value: number): string {
  const rounded = Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
  const minimumFractionDigits = Number.isInteger(rounded) ? 0 : 2;

  return `${rounded.toLocaleString("en-US", {
    minimumFractionDigits,
    maximumFractionDigits: 6,
  })} USDC`;
}

function formatNaira(value: number): string {
  return `NGN ${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(roundMoney(value)) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatNairaCompact(value: number): string {
  return `₦${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(roundMoney(value)) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function abbreviateAddress(value: string): string {
  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function isValidSolanaAddress(value: string): boolean {
  try {
    void new PublicKey(value.trim());
    return true;
  } catch {
    return false;
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return `${date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })} at ${date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function buildArenaNotFoundText(): string {
  return [
    "❌ Arena not found.",
    "",
    "Double-check the code and try again, or tap below to create your own.",
  ].join("\n");
}

function buildArenaStartedText(): string {
  return [
    "⏱ This arena has already started — joining is closed.",
    "",
    "Browse open arenas or create a fresh one below.",
  ].join("\n");
}

function buildArenaInsufficientBalanceText(
  entryFee: number,
  balance: number
): string {
  return [
    "💸 Not enough USDC.",
    "",
    `Entry fee:      ${c(formatMoney(entryFee))}`,
    `Your balance:   ${c(formatUsdc(balance))}`,
    "",
    "Top up your wallet and come back.",
  ].join("\n");
}

function buildStartWelcomeText(): string {
  return [
    "🏟 HeadlineOdds Arena",
    "",
    "Predict BTC UP or DOWN every 15 minutes.",
    "Best bankroll at the end wins the USDC prize pool.",
    "",
    "👇 Fund your wallet first — entry fees start at $0.50.",
    "Winnings land back in your wallet instantly.",
  ].join("\n");
}

function buildStartWelcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔴 Live Arenas", START_LOBBY)
    .text("⚡ Create Arena", ARENA_CREATE)
    .text("🎮 Free Trial", ARENA_FREE_TRIAL)
    .row()
    .text("💳 Wallet", START_WALLET)
    .text("❓ FAQ", START_HOW_IT_WORKS)
    .text("📊 Markets", "bm:list");
}

function buildFreeTrialWelcomeText(firstName: string): string {
  return [
    "🏟 HeadlineOdds Arena",
    "",
    `Welcome, ${firstName}!`,
    "",
    "Predict BTC UP or DOWN every 15 minutes.",
    "Best virtual bankroll at the end wins.",
    "",
    "🎮 Try a FREE arena — no deposit needed.",
    "You get $1,000 virtual funds and compete against 5 AI players.",
    "Top the leaderboard and earn 250 $HLO points.",
  ].join("\n");
}

function buildFreeTrialWelcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔴 Live Arenas", START_LOBBY)
    .text("⚡ Create Arena", ARENA_CREATE)
    .text("🎮 Free Trial", ARENA_FREE_TRIAL)
    .row()
    .text("💳 Wallet", START_WALLET)
    .text("❓ FAQ", START_HOW_IT_WORKS)
    .text("📊 Markets", "bm:list");
}

function buildFreeTrialCreatedText(code: string): string {
  return [
    "🎮 Free Trial Arena Created!",
    "",
    `📋 Arena Code: \`${code}\``,
    `💰 Virtual Bankroll: \`$1,000\``,
    `⏱️ Duration: \`1 hour\` • \`4 rounds\``,
    "",
    "🤖 AI Players Already In:",
    `• ${AGENT_DISPLAY_NAMES["aggressive"]} • ${AGENT_DISPLAY_NAMES["conservative"]} • ${AGENT_DISPLAY_NAMES["random"]}`,
    `• ${AGENT_DISPLAY_NAMES["trend"]} • ${AGENT_DISPLAY_NAMES["contrarian"]}`,
    "",
    `Share: https://t.me/share/url?url=Join%20my%20HeadlineOdds%20Arena%20with%20code%20${code}%20-%20no%20deposit%20needed!`,
    "",
    "I'll ping you when round 1 opens. Good luck! 🚀",
  ].join("\n");
}

function buildHowItWorksText(): string {
  return [
    "❓ How HeadlineOdds Arena works",
    "",
    "1️⃣  Fund your wallet — USDC on Solana or Naira bank transfer",
    "2️⃣  Join an arena — entry fees from $1 to $10",
    "3️⃣  Each 15-min round, pick ↑ UP or ↓ DOWN on BTC/USD",
    "4️⃣  Best virtual bankroll at the end wins the prize pool",
    "",
    "Winnings land in your in-bot balance instantly.",
    "Withdraw to any Solana wallet anytime.",
  ].join("\n");
}

function buildHowItWorksKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🏟 Browse Arenas", START_LOBBY)
    .text("💳 Wallet", START_WALLET);
}

function buildBtcChartKeyboard(): InlineKeyboard {
  const url = getBtcChartMenuUrl();
  const keyboard = new InlineKeyboard();

  if (url) {
    keyboard.url("Open chart", url).row();
  }

  keyboard.text("🏟 Browse arenas", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildStartOnboardingText(input: {
  firstName: string;
  balance: number;
}): string {
  const name = input.firstName.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
  const balance = input.balance.toFixed(2);
  return [
    `🏟 *HeadlineOdds Arena*`,
    "",
    `Welcome back, ${name}\\!`,
    `Pick an arena, call BTC UP or DOWN, win USDC\\.`,
    "",
    `💳 *Balance:* \`$${balance} USDC\``,
  ].join("\n");
}

function buildStartOnboardingKeyboard(_showFreeTrial = false): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔴 Live Arenas", START_LOBBY)
    .text("⚡ Create Arena", ARENA_CREATE)
    .text("🎮 Free Trial", ARENA_FREE_TRIAL)
    .row()
    .text("💳 Wallet", START_WALLET)
    .text("❓ FAQ", START_HOW_IT_WORKS)
    .text("📊 Markets", "bm:list");
}

function buildCreateArenaPickerText(balance: number): string {
  return [
    "⚡ Create an Arena",
    "",
    "Choose an entry fee — everyone who joins pays the same amount.",
    "The prize pool grows with every new player.",
    "",
    `Your balance: ${c(formatUsdc(balance))}`,
  ].join("\n");
}

function buildCreateArenaPickerKeyboard(telegramId?: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  // Row 1: $0.50, $1
  keyboard.text("$0.50", "arena:create:0.5").text("$1", "arena:create:1").row();
  // Row 2: $2, $5
  keyboard.text("$2", "arena:create:2").text("$5", "arena:create:5").row();
  // Row 3: $10, Custom
  keyboard.text("$10", "arena:create:10").text("✏️ Custom", ARENA_CREATE_CUSTOM);

  return keyboard;
}

function buildCreateArenaDurationText(input: {
  balance: number;
  entryFee: number;
}): string {
  const entryFeeText = formatMoney(input.entryFee, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  return [
    "⚡ Create an Arena",
    "",
    `Entry fee: ${c(entryFeeText)}`,
    "",
    "How long should the arena run?",
    `Rounds fire every ${c("15 minutes")} — ${c("4 rounds")} per hour.`,
    "",
    `Your balance: ${c(formatUsdc(input.balance))}`,
  ].join("\n");
}

function buildCreateArenaDurationKeyboard(entryFee: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  ARENA_DURATION_HOURS_OPTIONS.forEach((hours, index) => {
    keyboard.text(
      formatDurationHours(hours),
      `${ARENA_DURATION_PREFIX}${entryFee}:${hours}`
    );

    if (index % 2 === 1 && index < ARENA_DURATION_HOURS_OPTIONS.length - 1) {
      keyboard.row();
    }
  });

  keyboard
    .row()
    .text("⚡ Pick a different fee", ARENA_CREATE)
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);

  return keyboard;
}

function buildAgentPickerText(entryFee: number, durationHours: number): string {
  return [
    "🤖 Pick Your Agent",
    "",
    `Entry: ${c(formatMoney(entryFee, { minimumFractionDigits: 0, maximumFractionDigits: 2 }))}  •  Duration: ${c(formatDurationHours(durationHours))}`,
    "",
    "Your agent will trade automatically each round using live BTC signals.",
    "You watch the leaderboard — your agent wins or loses real USDC for you.",
    "",
    "Choose a strategy:",
  ].join("\n");
}

function buildAgentPickerKeyboard(entryFee: number, durationHours: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const styles = [...AGENT_STYLES];

  // Row 1: First 3 agents
  kb.text(AGENT_DISPLAY_NAMES[styles[0]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[0]}`)
    .text(AGENT_DISPLAY_NAMES[styles[1]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[1]}`)
    .text(AGENT_DISPLAY_NAMES[styles[2]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[2]}`)
    .row();
  // Row 2: Next 3 agents
  kb.text(AGENT_DISPLAY_NAMES[styles[3]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[3]}`)
    .text(AGENT_DISPLAY_NAMES[styles[4]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[4]}`)
    .text(AGENT_DISPLAY_NAMES[styles[5]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[5]}`)
    .row();
  // Row 3: Next 3 agents
  kb.text(AGENT_DISPLAY_NAMES[styles[6]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[6]}`)
    .text(AGENT_DISPLAY_NAMES[styles[7]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[7]}`)
    .text(AGENT_DISPLAY_NAMES[styles[8]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[8]}`)
    .row();
  // Row 4: Last agent + Trade myself + Back
  kb.text(AGENT_DISPLAY_NAMES[styles[9]], `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:${styles[9]}`)
    .text("🙋 Trade myself", `${ARENA_AGENT_PREFIX}${entryFee}:${durationHours}:none`)
    .text("← Back", `${ARENA_DURATION_PREFIX}${entryFee}:${durationHours}`);
  return kb;
}

function buildArenaStatusText(input: {
  code: string;
  memberCount: number;
  rank: number | null;
  balance: number | null;
  status: string;
  endAt: string;
}): string {
  if (input.status === "OPEN") {
    return `${c(input.code)}  •  OPEN  •  Waiting for players`;
  }

  const rankText =
    input.rank === null ? "Unranked" : `Rank ${c(`#${input.rank} of ${input.memberCount}`)}`;
  const endText =
    input.status === "LIVE"
      ? `Ends ${c(formatCompactDuration(Date.parse(input.endAt) - Date.now()))}`
      : "Starts next round";
  const balanceText =
    input.balance === null ? "" : `  •  ${c(formatWholeMoney(input.balance))}`;

  return `${c(input.code)}  •  ${escapeHtml(input.status)}  •  ${rankText}${balanceText}  •  ${endText}`;
}

function buildActiveArenaListKeyboard(codes: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const code of codes) {
    keyboard
      .text("📈 Status", `arena:status:${code}`)
      .text("🎯 Leaderboard", `arena:board:${code}`)
      .row();
  }

  keyboard.text("⚡ Create New Arena", ARENA_CREATE).text("🏟 Browse Lobby", START_LOBBY);
  return keyboard;
}

function buildArenaLobbyText(input: {
  live: Array<{
    code: string;
    entryFee: number;
    memberCount: number;
    prizePool: number;
    endsInText: string;
    startsInText: string | null;
    topReturnPct: number | null;
  }>;
  filling: Array<{
    code: string;
    entryFee: number;
    memberCount: number;
    prizePool: number;
    endsInText: string;
    startsInText: string | null;
    topReturnPct: number | null;
  }>;
  open: Array<{
    code: string;
    entryFee: number;
    memberCount: number;
    prizePool: number;
    endsInText: string;
    startsInText: string | null;
    topReturnPct: number | null;
  }>;
  liveOnly?: boolean;
}): string {
  const sections: string[] = [];

  const pushCard = (
    title: string,
    emoji: string,
    cards: typeof input.live,
    state: "LIVE" | "FILLING" | "OPEN"
  ) => {
    if (cards.length === 0) return;

    sections.push(title, "");

    for (const card of cards) {
      sections.push(
        `${emoji} ${c(card.code)}  ·  ${c(`${formatMoney(card.entryFee, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })} entry`)}  ·  ${c(`${card.memberCount} ${card.memberCount === 1 ? "player" : "players"}`)}`,
        `🏆 Prize pool: ${c(formatMoney(card.prizePool))}`
      );

      if (state === "LIVE") {
        sections.push(`⏱ Ends in: ${c(card.endsInText)}`);
        if (card.topReturnPct !== null && card.memberCount >= 2) {
          sections.push(`📈 Top player: ${c(formatSignedPercent(card.topReturnPct))}`);
        }
      } else if (state === "FILLING" && card.startsInText) {
        sections.push(`🕐 Starts in: ${c(card.startsInText)}`);
      } else if (state === "OPEN") {
        sections.push(`🟢 Waiting for players`);
      }
    }

    sections.push("");
  };

  pushCard("🔴 LIVE NOW", "🔴", input.live, "LIVE");

  if (!input.liveOnly) {
    pushCard("🟡 FILLING UP", "🟡", input.filling, "FILLING");
    pushCard("🟢 OPEN TO JOIN", "🟢", input.open, "OPEN");
  }

  if (sections.length === 0) {
    return input.liveOnly
      ? ["No live arenas right now.", "", "Check back soon or create a fresh one below."].join("\n")
      : ["No arenas running right now.", "", "Be the first — create one below."].join("\n");
  }

  return sections.join("\n").trim();
}

function buildArenaLobbyKeyboard(input: {
  live: Array<{ code: string; entryFee: number }>;
  filling: Array<{ code: string; entryFee: number }>;
  open: Array<{ code: string; entryFee: number }>;
  joinedCodes: string[];
  liveOnly?: boolean;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const joinedCodes = new Set(input.joinedCodes);

  for (const card of input.live) {
    keyboard
      .text(
        `${joinedCodes.has(card.code) ? "🔴 Live" : "👁 Watch"} ${card.code}`,
        joinedCodes.has(card.code)
          ? `${ARENA_LIVE_PREFIX}${card.code}`
          : `arena:watch:${card.code}`
      )
      .row();
  }

  if (!input.liveOnly) {
    for (const card of [...input.filling, ...input.open]) {
      if (joinedCodes.has(card.code)) {
        keyboard.text(`📈 Open ${card.code}`, `arena:status:${card.code}`).row();
        continue;
      }

      keyboard
        .text(
          `🎯 Join ${card.code} - ${formatMoney(card.entryFee, {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0,
          })}`,
          `arena:join:${card.code}`
        )
        .row();
    }
  }

  keyboard.text("⚡ Create New Arena", ARENA_CREATE);

  if (input.liveOnly) {
    keyboard.text("🏟 Browse all", START_LOBBY);
  } else {
    keyboard.text("🔄 Refresh", LOBBY_REFRESH);
  }

  return keyboard;
}

function buildFantasyJoinPreviewText(input: {
  code: string;
  entryFee: number;
  durationHours: number;
  virtualFunds: number;
  prizePool: number;
  playerCount: number;
  roundsUntilStart: number;
  currentLeaderName: string | null;
  currentLeaderReturnPct: number | null;
  projectedFirstPrize: number;
  startAt: string;
  balance: number;
  afterJoiningBalance: number;
}): string {
  const startsInText =
    input.roundsUntilStart <= 0
      ? "Starts next BTC round"
      : `Starts in ${c(`~${input.roundsUntilStart * 15} min`)}`;
  const durationText = `${formatDurationHours(input.durationHours)}  ·  ${getRoundsForDurationHours(input.durationHours)} rounds`;

  return [
    `⚡ Arena ${c(input.code)}`,
    "",
    `Entry fee:       ${c(formatMoney(input.entryFee))}`,
    `Prize pool:      ${c(formatMoney(input.prizePool))}  (${c(`${input.playerCount} ${input.playerCount === 1 ? "player" : "players"}`)})`,
    `1st place wins:  ${c(formatMoney(input.projectedFirstPrize))}`,
    "",
    `Duration:        ${c(durationText)}`,
    `${startsInText}`,
    input.currentLeaderName && input.currentLeaderReturnPct !== null
      ? `Current leader:  ${escapeHtml(input.currentLeaderName)}  ${c(formatSignedPercent(input.currentLeaderReturnPct))}`
      : `Starts:          ${c(formatDateTime(input.startAt))}`,
    "",
    `Balance after joining:  ${c(formatMoney(input.afterJoiningBalance))}`,
  ].join("\n");
}

function buildFantasyJoinPreviewKeyboard(entryFee: number): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      `✅ Confirm — Pay ${formatMoney(entryFee, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      })}`,
      ARENA_JOIN_CONFIRM
    )
    .text("❌ Cancel", ARENA_JOIN_DECLINE);
}

function buildFantasyCreateSuccessText(input: {
  code: string;
  prizePool: number;
  virtualStack: number;
  roundsUntilStart: number;
  durationHours: number;
}): string {
  return [
    "✅ Arena created!",
    "",
    `Code:           ${c(input.code)}`,
    `Prize pool:     ${c(formatMoney(input.prizePool))}  (grows as others join)`,
    `Your stack:     ${c(formatWholeMoney(input.virtualStack))}`,
    `Duration:       ${c(formatDurationHours(input.durationHours))}`,
    input.roundsUntilStart <= 0
      ? "Starts:         Next BTC round"
      : `Starts:         ${c(`~${input.roundsUntilStart * 15} min`)}`,
    "",
    "I'll ping you when round 1 opens. Share the invite to fill the pool!",
  ].join("\n");
}

function buildFantasyJoinSuccessText(input: {
  code: string;
  virtualBalance: number;
  playBalance: number;
  prizePool: number;
  playerCount: number;
  roundsUntilStart: number;
  durationHours: number;
}): string {
  return [
    "🟢 You're in!",
    "",
    `Arena:          ${c(input.code)}`,
    `Your stack:     ${c(formatWholeMoney(input.virtualBalance))}`,
    `Prize pool:     ${c(formatMoney(input.prizePool))}  (${c(`${input.playerCount} ${input.playerCount === 1 ? "player" : "players"}`)})`,
    `Duration:       ${c(formatDurationHours(input.durationHours))}`,
    "",
    input.roundsUntilStart <= 0
      ? "Starts:         Next BTC round"
      : `Starts in:      ${c(`~${input.roundsUntilStart * 15} min`)}`,
    `Wallet balance: ${c(formatUsdc(input.playBalance))}`,
    "",
    "I'll ping you when round 1 opens.",
  ].join("\n");
}

function buildInsufficientBalanceWithOptionsText(balance: number): string {
  return [
    "💸 Your balance is too low to join an arena.",
    "",
    `Current balance: ${c(formatUsdc(balance))}`,
    "",
    "Top up your wallet to get started.",
  ].join("\n");
}

function buildInsufficientBalanceKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💵 Top up now", WALLET_NAIRA_HELP)
    .text("💳 Open wallet", WALLET_OPEN);
}

function buildCreateInsufficientKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💳 Open wallet", WALLET_OPEN)
    .text("⚡ Pick a lower fee", ARENA_CREATE);
}

function buildAddFundsText(): string {
  return [
    "💵 Add Funds",
    "",
    "• Deposit USDC on Solana — use /wallet for your deposit address.",
    "• Fund via Naira bank transfer — tap Fund NGN below.",
    "• Deposit from another chain — tap Other Chain below.",
    "",
    "Deposits credit your in-bot balance automatically.",
  ].join("\n");
}

function buildAddFundsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💳 Open wallet", WALLET_OPEN)
    .text("🏟 Browse arenas", FUNDS_BACK_TO_LOBBY);
}

function buildCustomFundsPromptText(): string {
  return buildAddFundsText();
}

function buildFundsAddedText(amount: number, balance: number): string {
  return [
    `Credited: ${c(formatUsdc(amount))}`,
    `Wallet balance: ${c(formatUsdc(balance))}`,
    "",
    "Your deposit has been credited.",
  ].join("\n");
}

function buildFundsAddedKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏟 Browse Arenas", START_LOBBY);
}

function buildWalletText(summary: Awaited<ReturnType<typeof getFantasyWalletSummary>>): string {
  const VISIBLE_ENTRY_TYPES = new Set(["deposit", "arena_entry", "fantasy_entry", "fantasy_prize", "withdrawal_request"]);
  const ledgerLines = summary.recentLedger
    .filter((e) => VISIBLE_ENTRY_TYPES.has(e.entry_type))
    .slice(0, 4)
    .map((entry) => {
      const sign = entry.direction === "credit" ? "+" : "−";
      const label =
        entry.entry_type === "deposit" ? "Deposit"
        : entry.entry_type === "arena_entry" || entry.entry_type === "fantasy_entry" ? "Arena entry"
        : entry.entry_type === "fantasy_prize" ? "Prize payout"
        : entry.entry_type === "withdrawal_request" ? "Withdrawal"
        : entry.entry_type.replace(/_/g, " ");
      return `  ${sign}${c(formatUsdc(entry.amount))}  ${escapeHtml(label)}`;
    });

  const withdrawalLines = summary.recentWithdrawals.length === 0
    ? ["  —"]
    : summary.recentWithdrawals.slice(0, 3).map((e) => {
        const icon = e.status === "completed" ? "done" : e.status === "failed" ? "failed" : "pending";
        return `  ${c(formatUsdc(e.amount))}  →  ${c(e.destination_address)}  [${escapeHtml(icon)}]`;
      });

  const onrampCount = summary.recentOnramps.length;
  const onrampLines = onrampCount === 0
    ? ["  —"]
    : summary.recentOnramps.slice(0, 3).map((e) => {
        const amt = e.actual_usdc_amount > 0 ? e.actual_usdc_amount : e.expected_usdc_amount;
        const icon = e.status.toUpperCase() === "COMPLETED" ? "done" : e.status.toUpperCase() === "FAILED" ? "failed" : "pending";
        return `  ${c(`₦${Math.round(e.fiat_amount).toLocaleString("en-US")}`)}  →  ${c(formatUsdc(amt))}  [${escapeHtml(icon)}]`;
      });

  const addr = summary.wallet.owner_address;

  return [
    "<b>WALLET</b>",
    "",
    `Balance\n<code>${formatUsdc(summary.balance)}</code>`,
    "",
    `Deposit Address\n<code>${addr}</code>`,
    "",
    `NGN Deposits`,
    ...onrampLines,
    "",
    "Withdrawals",
    ...withdrawalLines,
  ].join("\n");
}

// ── Wallet keyboard ──────────────────────────────────────────────────────────
function buildWalletKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Refresh", WALLET_REFRESH)
    .text("Fund NGN", WALLET_NAIRA_HELP)
    .text("Offramp NGN", "offramp:start")
    .row()
    .text("Other Chain", WALLET_CROSS_CHAIN)
    .text("Withdraw USDC", WALLET_WITHDRAW_HELP)
    .text("Arenas", WALLET_BACK);
}

function buildWalletCrossChainHelpText(): string {
  return [
    "🌐 Deposit from Another Chain",
    "",
    "Send from Bitcoin, Tron, Ethereum, or 70+ chains.",
    "Dextopus converts it to USDC and credits your wallet automatically.",
    "",
    "Command:",
    "  /wallet deposit-cross <chainId> <tokenAddress> <amount>",
    "",
    "Examples:",
    "  10 USDT from Tron:",
    "  /wallet deposit-cross 728126428 TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t 10",
    "",
    "  5 USDC from Ethereum:",
    "  /wallet deposit-cross 1 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 5",
  ].join("\n");
}

function buildWalletCrossChainResultText(input: {
  depositAddress: string;
  depositRequestId: string;
  originSymbol: string;
  expectedUsdcOut: number;
  expiresInSeconds: number;
}): string {
  const expiryMinutes = Math.round(input.expiresInSeconds / 60);
  return [
    "<b>CROSS-CHAIN DEPOSIT</b>",
    "",
    `Send your ${escapeHtml(input.originSymbol)} to`,
    c(input.depositAddress),
    "",
    `Expected credit  ${c(`~${formatUsdc(input.expectedUsdcOut)}`)}`,
    `Expires in       ${c(`${expiryMinutes} min`)}`,
    "",
    "USDC will appear in your wallet automatically after confirmation.",
  ].join("\n");
}

function buildWalletNairaHelpText(): string {
  return [
    "<b>FUND WITH NAIRA</b>",
    "",
    "Pick an amount — a bank transfer order will be generated via PajCash.",
    `Min: <code>${formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT)}</code>  ·  Max: <code>${formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT)}</code>`,
    "",
    "Your balance updates once USDC lands in your wallet.",
  ].join("\n");
}

function buildWalletNairaPickerKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[0]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[0]}`)
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[1]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[1]}`)
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[2]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[2]}`)
    .row()
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[3]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[3]}`)
    .text("✏️ Custom", WALLET_NAIRA_CUSTOM)
    .text("← Back", WALLET_NAIRA_BACK);
}

function buildWalletNairaCustomAmountText(): string {
  return [
    "💵 Custom amount",
    `Type any amount between ${c(formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT))} and ${c(formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT))}.`,
    `e.g.  ${c("3500")}  or  ${c("₦3,500")}`,
  ].join("\n");
}

function buildWalletNairaCustomAmountKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[0]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[0]}`)
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[1]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[1]}`)
    .row()
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[2]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[2]}`)
    .text(formatNairaCompact(WALLET_NAIRA_PRESET_AMOUNTS[3]), `${WALLET_NAIRA_AMOUNT_PREFIX}${WALLET_NAIRA_PRESET_AMOUNTS[3]}`)
    .row()
    .text("← Back", WALLET_NAIRA_BACK);
}

function buildWalletNairaAmountValidationText(message?: string): string {
  return [
    message ?? "Invalid amount.",
    `Min: ${c(formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT))}  •  Max: ${c(formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT))}`,
  ].join("\n");
}

function parseWalletNairaAmountInput(value: string): number | null {
  const normalized = value
    .trim()
    .replace(/ngn/gi, "")
    .replace(/₦/g, "")
    .replace(/,/g, "")
    .replace(/\s+/g, "");

  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getWalletNairaAmountError(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) {
    return buildWalletNairaAmountValidationText("Enter a valid Naira amount.");
  }

  if (amount < WALLET_NAIRA_MIN_AMOUNT) {
    return buildWalletNairaAmountValidationText(
      `Minimum Fund NGN amount is ${c(formatNairaCompact(WALLET_NAIRA_MIN_AMOUNT))}.`
    );
  }

  if (amount > WALLET_NAIRA_MAX_AMOUNT) {
    return buildWalletNairaAmountValidationText(
      `Maximum Fund NGN amount for now is ${c(formatNairaCompact(WALLET_NAIRA_MAX_AMOUNT))}.`
    );
  }

  return null;
}

function buildWalletNairaOrderKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💵 Top up again", WALLET_NAIRA_HELP)
    .text("💳 Wallet", WALLET_OPEN)
    .row()
    .text("🏟 Arenas", WALLET_BACK);
}

function buildWalletCommandHelpText(): string {
  return [
    "💳 Wallet commands",
    "",
    `  ${c("/wallet")}                          — View balance & deposit address`,
    `  ${c("/wallet refresh")}                  — Sync deposits & withdrawals`,
    `  ${c("/wallet fund-ngn 10000")}           — Create a Naira top-up order`,
    `  ${c("/wallet withdraw 5 <address>")}     — Withdraw USDC to Solana`,
  ].join("\n");
}

function buildWalletWithdrawAmountText(balance: number): string {
  return [
    "📤 Withdraw USDC",
    "",
    `Your balance: ${c(formatUsdc(balance))}`,
    `Minimum: ${c(formatUsdc(config.SOLANA_WITHDRAW_MIN_AMOUNT))}`,
    "",
    "How much do you want to withdraw?",
    `Type an amount, e.g.  ${c("5")}  or  ${c("10.50")}`,
  ].join("\n");
}

function buildWalletWithdrawAddressText(amount: number): string {
  return [
    `📤 Withdraw ${c(formatUsdc(amount))}`,
    "",
    "Paste your Solana wallet address:",
  ].join("\n");
}

function buildWithdrawCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("❌ Cancel", WALLET_OPEN);
}

function buildWalletNairaOrderText(input: {
  orderId: string;
  fiatAmount: number;
  expectedUsdcAmount: number;
  bankName: string;
  accountName: string;
  accountNumber: string;
}): string {
  return [
    "💰 NGN top-up order ready",
    "",
    `Send:           ${c(formatNaira(input.fiatAmount))}`,
    `You'll receive: ${c(`~${formatUsdc(input.expectedUsdcAmount)}`)}`,
    "",
    "Transfer to:",
    `  ${escapeHtml(input.accountName)}`,
    `  ${c(input.accountNumber)}  ·  ${escapeHtml(input.bankName)}`,
    "",
    `Reference: ${c(input.orderId)}`,
    "",
    "Your balance updates automatically once USDC arrives.",
  ].join("\n");
}

async function createWalletNairaOrderText(
  telegramId: number,
  amount: number
): Promise<string> {
  const order = await createFantasyPajCashOnramp({
    telegramId,
    fiatAmount: amount,
  });

  return buildWalletNairaOrderText({
    orderId: order.order_id,
    fiatAmount: order.fiat_amount,
    expectedUsdcAmount: order.expected_usdc_amount,
    bankName: order.bank_name ?? "PAJ CASH",
    accountName: order.account_name ?? "PAJ CASH",
    accountNumber: order.account_number ?? "Unavailable",
  });
}

function buildWalletWithdrawalRequestedText(input: {
  amount: number;
  destinationAddress: string;
}): string {
  return [
    "✅ Withdrawal queued",
    "",
    `Amount:  ${c(formatUsdc(input.amount))}`,
    `To:      ${c(input.destinationAddress)}`,
    "",
    "The Solana transfer will broadcast shortly.",
  ].join("\n");
}

function buildCatchUpText(input: {
  code: string;
  leaderName: string;
  gap: number;
  suggestedStake: number;
  requiredReturnMultiple: number;
}): string {
  return [
    `📊 ${escapeHtml(input.leaderName)} is ${c(formatWholeMoney(input.gap))} ahead of you.`,
    "",
    "To close the gap in one trade:",
    `  Stake ${c(formatWholeMoney(input.suggestedStake))} on the next round`,
    `  You'd need roughly a ${c(`${input.requiredReturnMultiple.toFixed(2)}x`)} return`,
    "",
    "High risk — but doable across 2–3 strong rounds.",
  ].join("\n");
}

function buildArenaStatusKeyboard(code: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚡ Live market", `${ARENA_LIVE_PREFIX}${code}`)
    .text("🎯 Full leaderboard", `arena:board:${code}`)
    .row()
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
}

function buildArenaLiveKeyboard(input: {
  code: string;
  canCatchUp: boolean;
  marketUrl?: string;
  tradeWindowOpen?: boolean;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (config.ARENA_URL) {
    const label = input.tradeWindowOpen ? "⚡ Trade Now" : "📊 View Arena";
    keyboard.webApp(label, `${config.ARENA_URL}/trade?code=${input.code}`).row();
  }

  if (input.marketUrl) {
    keyboard.url("View market", input.marketUrl);
  }

  keyboard.text("📊 Leaderboard", `arena:board:${input.code}`);

  if (input.canCatchUp) {
    keyboard.row().text("📊 What I need to win", `${ARENA_CATCH_UP_PREFIX}${input.code}`);
  }

  keyboard
    .row()
    .text("🔄 Refresh live", `${ARENA_LIVE_PREFIX}${input.code}`)
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);

  return keyboard;
}

function buildArenaBoardKeyboard(input: {
  code: string;
  canCatchUp: boolean;
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  keyboard.text("⚡ Live market", `${ARENA_LIVE_PREFIX}${input.code}`).row();

  if (input.canCatchUp) {
    keyboard.text("📊 What I need to win", `${ARENA_CATCH_UP_PREFIX}${input.code}`);
  }

  keyboard
    .text("🔄 Refresh", `${ARENA_REFRESH_PREFIX}${input.code}`)
    .row()
    .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);

  return keyboard;
}

function buildFantasyJoinSuccessKeyboard(shareUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (shareUrl) {
    keyboard.url("📤 Invite others", shareUrl);
  }

  keyboard.text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildFantasyCreateSuccessKeyboard(shareUrl?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (shareUrl) {
    keyboard.url("📤 Share invite", shareUrl);
  }

  keyboard.text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY);
  return keyboard;
}

function buildLeagueHelpText(): string {
  return [
    "🏟 HeadlineOdds Arena — Commands",
    "",
    `${c("/start")}              — Home screen`,
    `${c("/wallet")}             — Your USDC wallet & deposit address`,
    `${c("/fundngn")}            — Top up via Naira bank transfer`,
    `${c("/offrampngn")}         — Convert USDC back to Naira`,
    `${c("/withdraw <amt> <addr>")}  — Withdraw USDC to Solana`,
    `${c("/league")}             — Your active arenas`,
    `${c("/create <fee> <hrs>")} — Create an arena  e.g. ${c("/create 5 12")}`,
    `${c("/join <code>")}        — Join an arena by code`,
    `${c("/live <code>")}        — Current round & live market`,
    `${c("/board <code>")}       — Leaderboard`,
    `${c("/status <code>")}      — Arena details`,
    `${c("/chart")}              — BTC 15m chart`,
    "",
    `Entry fees: ${c("$1–$10")}  ·  Durations: ${c("3h / 9h / 12h / 24h")}`,
    `${c("4 rounds per hour")}  ·  ${c("8% commission")} on prize pool`,
  ].join("\n");
}

function buildChartCommandText(): string {
  return [
    "📊 BTC 15m Chart",
    "",
    "Tap the button below to open the live BTC chart.",
    "If the menu button isn't visible, use the link below.",
  ].join("\n");
}

function buildChartCommandKeyboard(): InlineKeyboard | undefined {
  const url = getBtcChartMenuUrl();

  if (!url) {
    return undefined;
  }

  return new InlineKeyboard().url("📊 Open BTC 15m Chart", url);
}

async function replyChartCommand(ctx: Context): Promise<void> {
  const keyboard = buildChartCommandKeyboard();

  if (keyboard) {
    await ctx.reply(buildChartCommandText(), {
      reply_markup: keyboard,
    });
    return;
  }

  await ctx.reply(
    "BTC chart is not available right now. Set WEBHOOK_URL to enable the chart page."
  );
}

async function replyArenaLookupError(ctx: Context, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (
    message.includes("arena not found") ||
    message.includes("league not found")
  ) {
    await ctx.reply(buildArenaNotFoundText());
    return;
  }

  await ctx.reply("Something went wrong. Please try again.");
}

async function replyFantasyCreateError(
  ctx: Context,
  error: unknown,
  entryFee: number
): Promise<void> {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();

  if (
    normalized.includes("insufficient play balance") ||
    normalized.includes("insufficient balance")
  ) {
    if (!ctx.from) {
      await editTradePromptMessage(ctx, "Something went wrong. Please try again.");
      return;
    }

    const balance = await getBalance(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildArenaInsufficientBalanceText(entryFee, balance),
      buildCreateInsufficientKeyboard(),
      "HTML"
    );
    return;
  }

  if (
    normalized.includes("entry fee must") ||
    normalized.includes("duration must")
  ) {
    await editTradePromptMessage(ctx, message);
    return;
  }

  if (
    normalized.includes("no upcoming btc 15m round") ||
    normalized.includes("no open btc 15m round")
  ) {
    await editTradePromptMessage(
      ctx,
      "No BTC round is available right now. Try again in a minute."
    );
    return;
  }

  if (normalized.includes("bayse api")) {
    await editTradePromptMessage(
      ctx,
      "Couldn't reach the market right now. Please try again in a moment."
    );
    return;
  }

  await editTradePromptMessage(ctx, "Something went wrong. Please try again.");
}

async function replyFantasyJoinError(
  ctx: Context,
  error: unknown,
  code?: string
): Promise<void> {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();

  if (
    normalized.includes("arena not found") ||
    normalized.includes("league not found")
  ) {
    await ctx.reply(buildArenaNotFoundText());
    return;
  }

  if (
    normalized.includes("already started") ||
    normalized.includes("no longer open for joining")
  ) {
    await ctx.reply(buildArenaStartedText());
    return;
  }

  if (
    normalized.includes("insufficient play balance") ||
    normalized.includes("insufficient balance")
  ) {
    if (!ctx.from) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    const [details, balance] = await Promise.all([
      code ? getFantasyLeagueDetailsByCode(code).catch(() => null) : Promise.resolve(null),
      getBalance(ctx.from.id),
    ]);
    const entryFee = details?.game.entry_fee ?? 0;

    await ctx.reply(buildArenaInsufficientBalanceText(entryFee, balance), {
      parse_mode: "HTML",
      reply_markup: buildInsufficientBalanceKeyboard(),
    });
    return;
  }

  if (normalized.includes("already joined")) {
    await ctx.reply("You're already in this arena.");
    return;
  }

  await ctx.reply("Something went wrong. Please try again.");
}

function getPromptMessageRef(ctx: Context): {
  chatId: number | undefined;
  messageId: number | undefined;
} {
  const message = ctx.callbackQuery?.message;

  return {
    chatId: ctx.chat?.id,
    messageId:
      message && "message_id" in message ? message.message_id : undefined,
  };
}

function isWarmRoundCloseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  return (
    message.includes("round has ended") ||
    message.includes("round is no longer available") ||
    message.includes("league is not active right now") ||
    message.includes("league has already ended")
  );
}

function buildRoundClosedText(): string {
  return [
    "⏱ That round closed just before your trade locked in.",
    "",
    "No trade was placed — your balance is unchanged.",
    "The next BTC round prompt is coming shortly.",
  ].join("\n");
}

function buildTradeAlreadyLockedText(): string {
  return [
    "✅ You already have a trade locked in for this round.",
    "",
    "Sit tight — the result arrives when the round closes.",
  ].join("\n");
}

function formatTradeDirectionLabel(direction: "UP" | "DOWN"): string {
  return direction === "UP" ? "Buy YES" : "Buy NO";
}

function buildTradeLockedText(result: FantasyTradePlacementResult): string {
  const profit = roundMoney(result.shares - result.stake);
  const profitLabel = profit >= 0 ? `+${formatMoney(profit)}` : formatMoney(profit);
  return [
    `✅ Round ${c(`#${result.roundNumber}`)} locked · ${c(result.game.code)}`,
    "",
    `Direction:        ${result.direction === "UP" ? "⬆ YES" : "⬇ NO"}`,
    `Stake:            ${c(formatMoney(result.stake))}`,
    `If correct:       ${c(profitLabel)} profit`,
    `Balance:          ${c(formatMoney(result.remainingBalance))}`,
    "",
    "Result arrives when the round closes. Good luck! 🎯",
  ].join("\n");
}

function buildTradeLockedKeyboard(code: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("🏆 Leaderboard", `arena:board:${code}`)
    .text("🏟 Lobby", ARENA_BACK_TO_LOBBY);
}

async function editTradePromptMessage(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
  parse_mode?: "HTML" | "MarkdownV2" | "Markdown"
): Promise<void> {
  const { chatId, messageId } = getPromptMessageRef(ctx);

  if (chatId !== undefined && messageId !== undefined) {
    try {
      await ctx.editMessageText(text, {
        reply_markup: keyboard ?? new InlineKeyboard(),
        ...(parse_mode ? { parse_mode } : {}),
      });
      return;
    } catch (error) {
      const normalized = error instanceof Error ? error.message.toLowerCase() : "";

      if (normalized.includes("message is not modified")) {
        return;
      }
    }
  }

  if (keyboard) {
    await ctx.reply(text, { reply_markup: keyboard, ...(parse_mode ? { parse_mode } : {}) });
    return;
  }

  await ctx.reply(text, parse_mode ? { parse_mode } : {});
}

async function renderArenaLobby(
  ctx: Context,
  telegramId: number,
  options?: { liveOnly?: boolean }
): Promise<void> {
  const [lobby, snapshots] = await Promise.all([
    listFantasyArenaLobby(),
    listFantasyLeagueSnapshots(telegramId),
  ]);
  const mapCard = (card: (typeof lobby.live)[number]) => ({
    code: card.game.code,
    entryFee: card.game.entry_fee,
    memberCount: card.memberCount,
    prizePool: card.game.prize_pool,
    endsInText: formatCompactDuration(Date.parse(card.game.end_at) - Date.now()),
    startsInText:
      card.state === "FILLING"
        ? `~${Math.max(1, getApproxRoundsUntil(card.game.start_at)) * 15} min`
        : null,
    topReturnPct: card.topLeaderReturnPct,
  });

  const live = lobby.live.map(mapCard);
  const filling = lobby.filling.map(mapCard);
  const open = lobby.open.map(mapCard);
  const joinedCodes = snapshots.map((snapshot) => snapshot.game.code);

  await editTradePromptMessage(
    ctx,
    buildArenaLobbyText({
      live,
      filling,
      open,
      liveOnly: options?.liveOnly,
    }),
    buildArenaLobbyKeyboard({
      live,
      filling,
      open,
      joinedCodes,
      liveOnly: options?.liveOnly,
    }),
    "HTML"
  );
}

async function renderWalletView(
  ctx: Context,
  telegramId: number,
  options?: { refresh?: boolean }
): Promise<void> {
  const initial = await getFantasyWalletSummary(telegramId);

  if (options?.refresh) {
    await syncFantasyWalletDeposits(initial.wallet);
    await processFantasyWalletWithdrawals();
  }

  const summary = options?.refresh
    ? await getFantasyWalletSummary(telegramId)
    : initial;

  await editTradePromptMessage(
    ctx,
    buildWalletText(summary),
    buildWalletKeyboard(),
    "HTML"
  );
}

async function openLobbyOrFundingPrompt(
  ctx: Context,
  telegramId: number,
  options?: { liveOnly?: boolean }
): Promise<void> {
  const balance = await getBalance(telegramId);

  if (!options?.liveOnly && balance < FANTASY_MIN_ENTRY_FEE) {
    await editTradePromptMessage(
      ctx,
      buildInsufficientBalanceWithOptionsText(balance),
      buildInsufficientBalanceKeyboard(),
      "HTML"
    );
    return;
  }

  await renderArenaLobby(ctx, telegramId, options);
}

async function renderArenaStatusList(ctx: Context, telegramId: number): Promise<void> {
  const snapshots = await listFantasyLeagueSnapshots(telegramId);

  if (snapshots.length === 0) {
    await openLobbyOrFundingPrompt(ctx, telegramId);
    return;
  }

  const lines = snapshots.map((snapshot) =>
    buildArenaStatusText({
      code: snapshot.game.code,
      memberCount: snapshot.memberCount,
      rank: snapshot.yourRank,
      balance: snapshot.yourVirtualBalance,
      status:
        snapshot.game.status === "active"
          ? "LIVE"
          : snapshot.game.status === "open"
            ? "OPEN"
            : snapshot.game.status.toUpperCase(),
      endAt: snapshot.game.end_at,
    })
  );

  await ctx.reply(
    ["Your active arenas:", "", ...lines].join("\n"),
    {
      parse_mode: "HTML",
      reply_markup: buildActiveArenaListKeyboard(
        snapshots.map((snapshot) => snapshot.game.code)
      ),
    }
  );
}

async function presentJoinPreview(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  const [preview, balance] = await Promise.all([
    getFantasyLeagueJoinPreview(telegramId, code),
    getBalance(telegramId),
  ]);

  if (balance < preview.game.entry_fee) {
    await editTradePromptMessage(
      ctx,
      buildArenaInsufficientBalanceText(preview.game.entry_fee, balance),
      buildInsufficientBalanceKeyboard(),
      "HTML"
    );
    return;
  }

  await savePendingFantasyLeagueJoin(telegramId, preview.game.code);

  await editTradePromptMessage(
    ctx,
    buildFantasyJoinPreviewText({
      code: preview.game.code,
      entryFee: preview.game.entry_fee,
      durationHours: getGameDurationHours(preview.game),
      virtualFunds: preview.game.virtual_start_balance,
      prizePool: preview.projectedPrizePool,
      playerCount: preview.memberCount,
      roundsUntilStart: getApproxRoundsUntil(preview.game.start_at),
      currentLeaderName: preview.currentLeaderName,
      currentLeaderReturnPct: preview.currentLeaderReturnPct,
      projectedFirstPrize: preview.projectedFirstPrize,
      startAt: preview.game.start_at,
      balance,
      afterJoiningBalance: roundMoney(balance - preview.game.entry_fee),
    }),
    buildFantasyJoinPreviewKeyboard(preview.game.entry_fee),
    "HTML"
  );
}

async function resolveArenaLiveCode(
  telegramId: number,
  code: string | undefined
): Promise<string | null> {
  if (code?.trim()) {
    return code.trim().toUpperCase();
  }

  const snapshots = await listFantasyLeagueSnapshots(telegramId);
  const active = snapshots.filter(
    (snapshot) =>
      snapshot.game.status === "active" && Date.parse(snapshot.game.end_at) > Date.now()
  );

  if (active.length === 1) {
    return active[0]?.game.code ?? null;
  }

  return null;
}

function buildArenaLiveText(input: {
  view: FantasyLeagueStatusViewData;
  snapshot: ArenaCurrentRoundSnapshot | null;
  spectating?: boolean;
}): string {
  const arenaMsRemaining = Date.parse(input.view.game.end_at) - Date.now();
  const joined = Boolean(input.view.me);
  const isActive =
    input.view.game.status === "active" && Date.parse(input.view.game.end_at) > Date.now();
  const lines: string[] = [];

  if (input.spectating && !joined) {
    lines.push("👀 Spectating", "");
  }

  lines.push(
    `⚡ Arena ${c(input.view.game.code)}  •  ${escapeHtml(isActive ? "LIVE" : input.view.game.status.toUpperCase())}`,
    ""
  );

  if (joined) {
    const returnPct =
      ((input.view.me!.virtual_balance - input.view.game.virtual_start_balance) /
        input.view.game.virtual_start_balance) *
      100;

    lines.push(
      `Your position: ${c(`#${input.view.me!.place} of ${input.view.memberCount}`)}`,
      `Stack: ${c(formatWholeMoney(input.view.me!.virtual_balance))}  (${c(formatSignedPercent(
        returnPct
      ))})`,
      `Prize if game ends now: ${c(formatMoney(input.view.prizeIfEndedNow))}`
    );
  } else {
    lines.push(`Players: ${c(input.view.memberCount)}`, "Mode: Spectator");
  }

  if (!isActive) {
    lines.push(
      "",
      input.view.game.status === "open"
        ? `Arena starts: ${c(formatDateTime(input.view.game.start_at))}`
        : `Arena ended: ${c(formatDateTime(input.view.game.end_at))}`,
      input.view.game.status === "open"
        ? `Starts in: ${c(`~${Math.max(1, getApproxRoundsUntil(input.view.game.start_at)) * 15} min`)}`
        : "No live Bayse market for this arena right now."
    );

    return lines.join("\n");
  }

  lines.push(`Arena time left: ${c(formatCompactDuration(arenaMsRemaining))}`);

  if (!input.snapshot?.pricing) {
    lines.push("", "Current Bayse BTC market is unavailable right now. Try again in a minute.");
    return lines.join("\n");
  }

  const roundOpeningMs = Date.parse(input.snapshot.round.openingDate);
  const roundClosingMs = Date.parse(input.snapshot.round.closingDate);
  const roundNumber = getGameRoundNumber(input.view.game, input.snapshot.round.openingDate);
  const tradeWindowCloseMs =
    Number.isFinite(roundOpeningMs) && Number.isFinite(roundClosingMs)
      ? roundOpeningMs + (roundClosingMs - roundOpeningMs) * 0.2
      : null;

  lines.push(
    "",
    `Current round: ${c(`#${roundNumber}`)}`,
    `BTC/USD: ${c(formatBtcPrice(
      input.snapshot.pricing.eventThreshold ?? input.snapshot.round.eventThreshold
    ))}`,
    `↑ UP  ${c(formatProbabilityPrice(input.snapshot.pricing.upPrice))}   •   ↓ DOWN  ${c(formatProbabilityPrice(
      input.snapshot.pricing.downPrice
    ))}`,
    `Round time left: ${c(formatRoundCountdown(input.snapshot.round.closingDate))}`,
    `Round closes: ${c(formatDateTime(input.snapshot.round.closingDate))}`,
    tradeWindowCloseMs === null
      ? "Trade window: unavailable"
      : tradeWindowCloseMs > Date.now()
      ? `⚡ Trade window: ${c(formatCompactDuration(tradeWindowCloseMs - Date.now()))} left — tap Trade below`
      : "Trade window closed • Next round opens soon"
  );

  return lines.join("\n");
}

async function renderArenaLiveView(
  ctx: Context,
  telegramId: number,
  code: string,
  options?: { spectating?: boolean }
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const snapshot =
    view.game.status === "active" && Date.parse(view.game.end_at) > Date.now()
      ? await getCurrentRoundSnapshot("BTC")
      : null;

  await editTradePromptMessage(
    ctx,
    buildArenaLiveText({
      view,
      snapshot,
      spectating: options?.spectating,
    }),
    buildArenaLiveKeyboard({
      code: view.game.code,
      canCatchUp: Boolean(view.me && view.me.place > 1),
      marketUrl: snapshot?.pricing?.url,
      tradeWindowOpen: (() => {
        if (!snapshot) return false;
        const open = Date.parse(snapshot.round.openingDate);
        const close = Date.parse(snapshot.round.closingDate);
        return Date.now() < open + (close - open) * 0.2;
      })(),
    }),
    "HTML"
  );
}

async function renderArenaStatusView(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const settledTrades =
    (view.me?.wins ?? 0) + (view.me?.losses ?? 0);
  const accuracyText =
    settledTrades > 0
      ? `${view.me?.wins ?? 0}/${settledTrades} (${roundMoney(
          ((view.me?.wins ?? 0) / settledTrades) * 100
        )}%)`
      : "0/0 (0%)";
  const lastRoundText = view.lastTrade
    ? `${escapeHtml(view.lastTrade.direction)} ${
        view.lastTrade.outcome === "WIN"
          ? "✅"
          : view.lastTrade.outcome === "LOSS"
            ? "❌"
            : "•"
      }  ${view.lastTrade.outcome === "WIN" ? c(`+${formatMoney(view.lastTrade.payout)}`) : ""}`.trim()
    : "No trades yet";

  const text = [
    `Arena ${c(view.game.code)}  •  ${escapeHtml(view.game.status.toUpperCase())}`,
    "",
    `Your position: ${
      view.me ? c(`#${view.me.place} of ${view.memberCount}`) : "Not joined"
    }`,
    `Stack: ${c(formatWholeMoney(view.me?.virtual_balance ?? view.game.virtual_start_balance))}  (${c(formatSignedPercent(
      view.me
        ? ((view.me.virtual_balance - view.game.virtual_start_balance) /
            view.game.virtual_start_balance) *
            100
        : 0
    ))})`,
    `Rounds left: ${c(`~${view.roundsLeft}  (~${view.roundsLeft * 15} min)`)}`,
    `Prize if game ends now: ${c(formatMoney(view.prizeIfEndedNow))}`,
    "",
    `Last round: ${lastRoundText}`,
    `Accuracy: ${c(accuracyText)}`,
  ].join("\n");

  await editTradePromptMessage(
    ctx,
    text,
    new InlineKeyboard()
      .text("Full leaderboard", `arena:board:${view.game.code}`)
      .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY),
    "HTML"
  );
}

async function renderArenaBoardView(
  ctx: Context,
  telegramId: number,
  code: string,
  options?: { spectating?: boolean }
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const text = await getFantasyLeagueBoardText(code, telegramId);

  await editTradePromptMessage(
    ctx,
    options?.spectating ? ["👀 Spectating", "", text].join("\n") : text,
    buildArenaBoardKeyboard({
      code: view.game.code,
      canCatchUp: Boolean(view.me && view.me.place > 1),
    })
  );
}

async function renderCatchUpView(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  const view = await getFantasyLeagueStatusView(telegramId, code);
  const leader = view.leaderboard[0] ?? null;

  if (!view.me || !leader || leader.telegram_id === telegramId) {
    await renderArenaBoardView(ctx, telegramId, code);
    return;
  }

  const gap = Math.max(0, leader.virtual_balance - view.me.virtual_balance);
  const suggestedStake = 100;
  const requiredReturnMultiple = gap / suggestedStake + 1;

  await editTradePromptMessage(
    ctx,
    buildCatchUpText({
      code,
      leaderName: anonymizePlayer(leader.telegram_id, telegramId, leader.username),
      gap,
      suggestedStake,
      requiredReturnMultiple,
    }),
    new InlineKeyboard()
      .text("Back to leaderboard", `arena:board:${code}`)
      .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY),
    "HTML"
  );
}

async function renderArenaWatchView(
  ctx: Context,
  telegramId: number,
  code: string
): Promise<void> {
  await renderArenaLiveView(ctx, telegramId, code, { spectating: true });
}

async function getArenaInviteShareUrl(
  ctx: Context,
  input: { code: string; entryFee: number }
): Promise<string | undefined> {
  try {
    const me = await ctx.api.getMe();

    if (!me.username) {
      return undefined;
    }

    return buildShareInviteUrl({
      botUsername: me.username,
      code: input.code,
      entryFee: input.entryFee,
    });
  } catch (error) {
    console.warn("[bot] Failed to build arena invite share URL:", error);
    return undefined;
  }
}

async function renderCreateArenaDurationPicker(
  ctx: Context,
  telegramId: number,
  entryFee: number
): Promise<void> {
  const balance = await getBalance(telegramId);

  await editTradePromptMessage(
    ctx,
    buildCreateArenaDurationText({
      balance,
      entryFee,
    }),
    buildCreateArenaDurationKeyboard(entryFee),
    "HTML"
  );
}

async function createArenaFromSelection(
  ctx: Context,
  telegramId: number,
  entryFee: number,
  durationHours: number
): Promise<void> {
  const game = await createFantasyLeagueGame(telegramId, entryFee, durationHours);
  const shareUrl = await getArenaInviteShareUrl(ctx, {
    code: game.code,
    entryFee: game.entry_fee,
  });

  await editTradePromptMessage(
    ctx,
    buildFantasyCreateSuccessText({
      code: game.code,
      prizePool: game.prize_pool,
      virtualStack: game.virtual_start_balance,
      roundsUntilStart: getApproxRoundsUntil(game.start_at),
      durationHours: getGameDurationHours(game),
    }),
    buildFantasyCreateSuccessKeyboard(shareUrl),
    "HTML"
  );
}

export async function handleStart(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const code = args[0]?.trim()?.toUpperCase();

  if (code) {
    try {
      await presentJoinPreview(ctx, ctx.from.id, code);
    } catch (error) {
      await replyFantasyJoinError(ctx, error, code);
    }

    return;
  }

  const balance = await getBalance(ctx.from.id);
  const usedTrial = await hasUsedFreeTrial(ctx.from.id).catch(() => false);

  if (balance <= 0) {
    if (!usedTrial) {
      const firstName = ctx.from.first_name?.trim() || "there";
      await ctx.reply(buildFreeTrialWelcomeText(firstName), {
        reply_markup: buildFreeTrialWelcomeKeyboard(),
      });
      return;
    }
    await ctx.reply(buildStartWelcomeText(), {
      reply_markup: buildStartWelcomeKeyboard(),
    });
    return;
  }

  await ctx.reply(
    buildStartOnboardingText({
      firstName: ctx.from.first_name?.trim() || "there",
      balance,
    }),
    {
      parse_mode: "MarkdownV2",
      reply_markup: buildStartOnboardingKeyboard(!usedTrial),
    }
  );
}

export async function handleFantasyLeagueUiAction(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery?.data) {
    return;
  }

  const data = ctx.callbackQuery.data;

  if (data === START_HOW_IT_WORKS) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(ctx, buildHowItWorksText(), buildHowItWorksKeyboard());
    return;
  }

  if (data === "support:ask") {
    await ctx.reply("What would you like to know? Just type your question and I'll answer instantly.");
    return;
  }

  if (data === START_WALLET || data === WALLET_OPEN) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await clearWithdrawState(ctx.from.id);
    await clearPendingJoinCodeEntry(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data === START_LOBBY || data === LOBBY_REFRESH || data === ARENA_BACK_TO_LOBBY) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await clearWithdrawState(ctx.from.id);
    await clearPendingJoinCodeEntry(ctx.from.id);
    await openLobbyOrFundingPrompt(ctx, ctx.from.id);
    return;
  }

  if (data.startsWith(ARENA_TRADE_PREFIX)) {
    try {
      const prompt = await prepareFantasyTradePromptForArena({
        telegramId: ctx.from.id,
        code: data.slice(ARENA_TRADE_PREFIX.length),
      });
      const sent = await ctx.reply(prompt.text, {
        reply_markup: prompt.keyboard,
      });

      registerFantasyTradePromptDelivery({
        chatId: sent.chat.id,
        messageId: sent.message_id,
        telegramId: ctx.from.id,
        state: prompt.state,
      });
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data === LOBBY_LIVE) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await openLobbyOrFundingPrompt(ctx, ctx.from.id, { liveOnly: true });
    return;
  }

  if (data === FUNDS_ADD) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data === FUNDS_CUSTOM) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data === FUNDS_BACK_TO_LOBBY || data === WALLET_BACK) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await openLobbyOrFundingPrompt(ctx, ctx.from.id);
    return;
  }

  if (data === WALLET_REFRESH || data.startsWith("funds:amount:")) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data === WALLET_WITHDRAW_HELP) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const balance = await getBalance(ctx.from.id);
    await saveWithdrawState(ctx.from.id, { step: "amount" });
    await editTradePromptMessage(ctx, buildWalletWithdrawAmountText(balance), buildWithdrawCancelKeyboard(), "HTML");
    return;
  }

  if (data === WALLET_CROSS_CHAIN || data.startsWith("cc:")) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const handled = await handleCrossChainCallback(
      ctx, data,
      (text, kb) => editTradePromptMessage(ctx, text, kb, "HTML"),
      buildWalletKeyboard(),
      WALLET_BACK,
      WALLET_OPEN,
      renderWalletView,
    );
    if (handled) return;
  }

  if (data === WALLET_NAIRA_HELP) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildWalletNairaHelpText(),
      buildWalletNairaPickerKeyboard(),
      "HTML"
    );
    return;
  }

  if (data === "offramp:start") {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await handleOfframpNgn(ctx);
    return;
  }

  if (data === WALLET_NAIRA_CUSTOM) {
    await savePendingFantasyCustomFundAmount(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildWalletNairaCustomAmountText(),
      buildWalletNairaCustomAmountKeyboard(),
      "HTML"
    );
    return;
  }

  if (data === WALLET_NAIRA_BACK) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (data.startsWith(WALLET_NAIRA_AMOUNT_PREFIX)) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);

    const amount = Number.parseFloat(data.slice(WALLET_NAIRA_AMOUNT_PREFIX.length));
    const amountError = getWalletNairaAmountError(amount);

    if (amountError) {
      await editTradePromptMessage(
        ctx,
        amountError,
        buildWalletNairaPickerKeyboard(),
        "HTML"
      );
      return;
    }

    try {
      const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
      await editTradePromptMessage(ctx, orderText, buildWalletNairaOrderKeyboard(), "HTML");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await editTradePromptMessage(
        ctx,
        message,
        buildWalletNairaPickerKeyboard()
      );
    }

    return;
  }

  if (data === ARENA_FREE_TRIAL) {
    try {
      const game = await createFreeTrialArena(ctx.from.id);
      const shareUrl = await getArenaInviteShareUrl(ctx, { code: game.code, entryFee: 0 });
      const keyboard = new InlineKeyboard();
      if (shareUrl) keyboard.url("📤 Invite friends", shareUrl).row();
      keyboard.text("🏟 Browse Lobby", ARENA_BACK_TO_LOBBY);
      await editTradePromptMessage(ctx, buildFreeTrialCreatedText(game.code), keyboard);
    } catch (error) {
      console.error("[bot] Free trial arena creation failed:", error);
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      await editTradePromptMessage(ctx, msg, new InlineKeyboard().text("🏟 Back", START_LOBBY));
    }
    return;
  }

  if (data === ARENA_CREATE) {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const balance = await getBalance(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      buildCreateArenaPickerText(balance),
      buildCreateArenaPickerKeyboard(ctx.from.id),
      "HTML"
    );
    return;
  }

  if (data === OFFRAMP_CANCEL) {
    await clearOfframpSession(ctx.from.id);
    await ctx.editMessageText("Offramp cancelled. No funds were moved.").catch(() => null);
    return;
  }

  if (data.startsWith("offramp:bank:")) {
    const parts = data.slice("offramp:bank:".length).split(":");
    const bankId = parts[0] ?? "";
    const bankName = parts.slice(1).join(":") || bankId;

    const session = await loadOfframpSession(ctx.from.id);

    if (!session?.accountNumber) {
      await ctx.editMessageText("Session expired. Please try /offrampngn again.").catch(() => null);
      return;
    }

    try {
      const confirmation = await confirmBankAccount({ bankId, accountNumber: session.accountNumber });
      const accountName = confirmation.accountName;

      await saveOfframpSession(ctx.from.id, {
        step: "awaiting_usdc_amount",
        bankId,
        bankName: confirmation.bank?.name ?? bankName,
        accountNumber: session.accountNumber,
        accountName,
      });

      await ctx.editMessageText(
        [
          `✅ Account confirmed`,
          "",
          `Name:    ${escapeHtml(accountName)}`,
          `Number:  ${c(session.accountNumber)}`,
          `Bank:    ${escapeHtml(confirmation.bank?.name ?? bankName)}`,
          "",
          `Enter the USDC amount to convert (minimum ${c(formatUsdc(PAJCASH_OFFRAMP_MIN_USDC))}):`,
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: buildOfframpCancelKeyboard() }
      ).catch(() =>
        ctx.reply(
          `✅ Account confirmed: ${escapeHtml(accountName)}\n\nEnter USDC amount (minimum ${c(formatUsdc(PAJCASH_OFFRAMP_MIN_USDC))}):`,
          { parse_mode: "HTML", reply_markup: buildOfframpCancelKeyboard() }
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not confirm account.";
      await ctx.editMessageText(message, { reply_markup: buildOfframpCancelKeyboard() }).catch(() =>
        ctx.reply(message, { reply_markup: buildOfframpCancelKeyboard() })
      );
    }

    return;
  }

  if (data === OFFRAMP_CONFIRM) {
    const session = await loadOfframpSession(ctx.from.id);
    await clearOfframpSession(ctx.from.id);

    if (
      !session ||
      session.step !== "pending_confirm" ||
      !session.bankId ||
      !session.accountNumber ||
      !session.usdcAmount
    ) {
      await ctx.editMessageText("Session expired. Please try /offrampngn again.").catch(() => null);
      return;
    }

    try {
      const result = await createFantasyPajCashOfframp({
        telegramId: ctx.from.id,
        bankId: session.bankId,
        accountNumber: session.accountNumber,
        usdcAmount: session.usdcAmount,
      });

      const resultText = buildOfframpOrderText({
        orderId: result.order.order_id,
        usdcAmount: result.order.expected_usdc_amount,
        fiatAmount: result.order.fiat_amount,
        accountName: session.accountName ?? session.accountNumber,
        accountNumber: session.accountNumber,
        bankName: session.bankName ?? session.bankId,
        fundingSignature: result.fundingSignature,
      });

      await ctx.editMessageText(resultText, { parse_mode: "HTML", reply_markup: buildWalletKeyboard() }).catch(() =>
        ctx.reply(resultText, { parse_mode: "HTML", reply_markup: buildWalletKeyboard() })
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await ctx.editMessageText(message, { reply_markup: buildWalletKeyboard() }).catch(() =>
        ctx.reply(message, { reply_markup: buildWalletKeyboard() })
      );
    }

    return;
  }

  if (data === ARENA_CREATE_CUSTOM) {
    await savePendingCustomArenaFee(ctx.from.id);
    await editTradePromptMessage(
      ctx,
      `✏️ Enter your custom entry fee (e.g. ${c("15")}):\nMin: ${c("$0.50")}  ·  Max: ${c("$50")}`,
      new InlineKeyboard().text("← Back", ARENA_CREATE),
      "HTML"
    );
    return;
  }

  if (data.startsWith("arena:create:")) {
    const entryFee = Number.parseFloat(data.slice("arena:create:".length));

    if (!Number.isFinite(entryFee)) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    await renderCreateArenaDurationPicker(ctx, ctx.from.id, entryFee);
    return;
  }

  if (data.startsWith(ARENA_DURATION_PREFIX)) {
    const [entryFeeRaw, durationHoursRaw] = data
      .slice(ARENA_DURATION_PREFIX.length)
      .split(":");
    const entryFee = Number.parseFloat(entryFeeRaw ?? "");
    const durationHours = Number.parseInt(durationHoursRaw ?? "", 10);

    if (!Number.isFinite(entryFee) || !Number.isInteger(durationHours)) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    await editTradePromptMessage(
      ctx,
      buildAgentPickerText(entryFee, durationHours),
      buildAgentPickerKeyboard(entryFee, durationHours),
      "HTML"
    );
    return;
  }

  if (data.startsWith(ARENA_AGENT_PREFIX)) {
    const parts = data.slice(ARENA_AGENT_PREFIX.length).split(":");
    const entryFee = Number.parseFloat(parts[0] ?? "");
    const durationHours = Number.parseInt(parts[1] ?? "", 10);
    const agentStyle = parts[2] ?? "none";

    if (!Number.isFinite(entryFee) || !Number.isInteger(durationHours)) {
      await ctx.reply("Something went wrong. Please try again.");
      return;
    }

    try {
      if (agentStyle !== "none" && (AGENT_STYLES as readonly string[]).includes(agentStyle)) {
        const game = await createAgentArena(ctx.from.id, entryFee, durationHours, agentStyle as AgentStyle);
        const shareUrl = await getArenaInviteShareUrl(ctx, { code: game.code, entryFee: game.entry_fee });
        await editTradePromptMessage(
          ctx,
          buildFantasyCreateSuccessText({
            code: game.code,
            prizePool: game.prize_pool,
            virtualStack: game.virtual_start_balance,
            roundsUntilStart: getApproxRoundsUntil(game.start_at),
            durationHours: getGameDurationHours(game),
          }),
          buildFantasyCreateSuccessKeyboard(shareUrl),
          "HTML"
        );
      } else {
        await createArenaFromSelection(ctx, ctx.from.id, entryFee, durationHours);
      }
    } catch (error) {
      await replyFantasyCreateError(ctx, error, entryFee);
    }
    return;
  }

  if (data.startsWith("arena:join:")) {
    try {
      await presentJoinPreview(ctx, ctx.from.id, data.slice("arena:join:".length));
    } catch (error) {
      await replyFantasyJoinError(ctx, error, data.slice("arena:join:".length));
    }
    return;
  }

  if (data.startsWith(ARENA_LIVE_PREFIX)) {
    try {
      await renderArenaLiveView(ctx, ctx.from.id, data.slice(ARENA_LIVE_PREFIX.length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith("arena:watch:")) {
    try {
      await renderArenaWatchView(ctx, ctx.from.id, data.slice("arena:watch:".length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith("arena:board:")) {
    try {
      await renderArenaBoardView(ctx, ctx.from.id, data.slice("arena:board:".length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith(ARENA_REFRESH_PREFIX)) {
    try {
      await renderArenaBoardView(ctx, ctx.from.id, data.slice(ARENA_REFRESH_PREFIX.length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith(ARENA_CATCH_UP_PREFIX)) {
    try {
      await renderCatchUpView(ctx, ctx.from.id, data.slice(ARENA_CATCH_UP_PREFIX.length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith("arena:status:")) {
    try {
      await renderArenaStatusView(ctx, ctx.from.id, data.slice("arena:status:".length));
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }
    return;
  }

  if (data.startsWith(ARENA_REMIND_PREFIX)) {
    const code = data.slice(ARENA_REMIND_PREFIX.length);
    const confirmMsg = await ctx.reply(
      "🔔 Done! I'll ping you when the next round opens."
    ).catch(() => null);
    const saved = await saveFantasyNextRoundReminder(
      ctx.from.id,
      code,
      confirmMsg?.message_id
    );
    if (!saved) {
      if (confirmMsg) {
        await ctx.api.deleteMessage(ctx.chat!.id, confirmMsg.message_id).catch(() => undefined);
      }
      await ctx.reply("Couldn't set a reminder for that arena. Try again.");
    }
    return;
  }
}

export async function handleFantasyTextInput(ctx: Context): Promise<boolean> {
  if (!ctx.from) {
    return false;
  }

  const messageText = (ctx.message?.text ?? "").trim();
  if (!messageText || messageText.startsWith("/")) {
    return false;
  }

  // Custom arena entry fee (dev users only)
  if (await hasPendingCustomArenaFee(ctx.from.id)) {
    const fee = Number.parseFloat(messageText.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(fee) || fee <= 0) {
      await ctx.reply(`Enter a valid fee, e.g. ${c("0.20")}`, { parse_mode: "HTML" });
      return true;
    }
    await clearPendingCustomArenaFee(ctx.from.id);
    const balance = await getBalance(ctx.from.id);
    await ctx.reply(
      buildCreateArenaDurationText({ balance, entryFee: fee }),
      { parse_mode: "HTML", reply_markup: buildCreateArenaDurationKeyboard(fee) }
    );
    return true;
  }

  // Cross-chain deposit amount input
  const ccSession = await loadCrossChainSession(ctx.from.id);
  if (ccSession?.step === "awaiting_amount") {
    const amount = Number(messageText.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      await ctx.reply(`Enter a valid amount, e.g. ${c("10")}`, { parse_mode: "HTML", reply_markup: buildCrossChainAmountPromptKeyboard() });
      return true;
    }
    const updated: CrossChainSession = { ...ccSession, step: "pending_confirm", amount: String(amount) };
    await saveCrossChainSession(ctx.from.id, updated);
    await ctx.reply(buildCrossChainConfirmText(updated), { parse_mode: "HTML", reply_markup: buildCrossChainConfirmKeyboard() });
    return true;
  }

  // Offramp session handling
  const offrampSession = await loadOfframpSession(ctx.from.id);

  if (offrampSession) {
    if (offrampSession.step === "awaiting_bank_account") {
      const accountNumber = messageText.replace(/\D/g, "");

        if (accountNumber.length < 10) {
        await ctx.reply(`Enter a valid ${c("10-digit")} bank account number.`, {
          parse_mode: "HTML",
          reply_markup: buildOfframpCancelKeyboard(),
        });
        return true;
      }

      // Fetch banks and confirm account
      try {
        const banks = await getBanks();

        if (banks.length === 0) {
          await ctx.reply("No banks available right now. Please try again in a moment.", {
            reply_markup: buildOfframpCancelKeyboard(),
          });
          return true;
        }

        // We need the user to pick a bank — show a simplified prompt
        // Store account number and ask for bank selection via inline keyboard
        await saveOfframpSession(ctx.from.id, {
          step: "awaiting_bank_account",
          accountNumber,
        });

        const bankButtons = banks.slice(0, 20); // cap at 20 to avoid oversized keyboard
        const keyboard = new InlineKeyboard();

        for (let i = 0; i < bankButtons.length; i += 2) {
          const row = bankButtons.slice(i, i + 2);
          for (const bank of row) {
            keyboard.text(bank.name, `offramp:bank:${bank.id}:${bank.name.slice(0, 20)}`);
          }
          keyboard.row();
        }

        keyboard.text("❌ Cancel", OFFRAMP_CANCEL);

        await ctx.reply(`Account number: ${c(accountNumber)}\n\nSelect your bank:`, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Something went wrong.";
        await ctx.reply(message, { reply_markup: buildOfframpCancelKeyboard() });
      }

      return true;
    }

    if (offrampSession.step === "awaiting_usdc_amount") {
      const usdcAmount = Number.parseFloat(messageText.replace(/[^0-9.]/g, ""));

      if (!Number.isFinite(usdcAmount) || usdcAmount < PAJCASH_OFFRAMP_MIN_USDC) {
        await ctx.reply(
          `Enter a valid USDC amount (minimum ${c(formatUsdc(PAJCASH_OFFRAMP_MIN_USDC))}).`,
          { parse_mode: "HTML", reply_markup: buildOfframpCancelKeyboard() }
        );
        return true;
      }

      const balance = await getBalance(ctx.from.id);

      if (balance < usdcAmount) {
        await ctx.reply(
          `💸 Insufficient balance.\n\nAvailable: ${c(formatUsdc(balance))}`,
          { parse_mode: "HTML", reply_markup: buildOfframpCancelKeyboard() }
        );
        return true;
      }

      await saveOfframpSession(ctx.from.id, {
        ...offrampSession,
        step: "pending_confirm",
        usdcAmount,
      });

      await ctx.reply(
        [
          "⚠️ Confirm offramp",
          "",
          `Account:       ${escapeHtml(offrampSession.accountName ?? "")}`,
          `Number:        ${c(offrampSession.accountNumber ?? "")}`,
          `Bank:          ${escapeHtml(offrampSession.bankName ?? "")}`,
          `USDC to send:  ${c(formatUsdc(usdcAmount))}`,
          "",
          "The USDC will be sent on-chain to PajCash, then your in-bot balance is debited.",
        ].join("\n"),
        { parse_mode: "HTML", reply_markup: buildOfframpConfirmKeyboard() }
      );

      return true;
    }
  }

  // Join by code flow
  if (await hasPendingJoinCodeEntry(ctx.from.id)) {
    const code = messageText.toUpperCase().replace(/[^A-Z0-9-]/g, "");
    if (!code) {
      await ctx.reply("Enter a valid arena code:", {
        reply_markup: new InlineKeyboard().text("❌ Cancel", START_LOBBY),
      });
      return true;
    }
    await clearPendingJoinCodeEntry(ctx.from.id);
    try {
      await presentJoinPreview(ctx, ctx.from.id, code);
    } catch (error) {
      await replyFantasyJoinError(ctx, error, code);
    }
    return true;
  }

  // Withdraw flow
  const withdrawState = await loadWithdrawState(ctx.from.id);
  if (withdrawState) {
    if (withdrawState.step === "amount") {
      const amount = Number.parseFloat(messageText.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(amount) || amount < config.SOLANA_WITHDRAW_MIN_AMOUNT) {
        const balance = await getBalance(ctx.from.id);
        await ctx.reply(
          `Minimum withdrawal is ${c(formatUsdc(config.SOLANA_WITHDRAW_MIN_AMOUNT))}. Enter a valid amount.`,
          { parse_mode: "HTML", reply_markup: buildWithdrawCancelKeyboard() }
        );
        return true;
      }
      const balance = await getBalance(ctx.from.id);
      if (amount > balance) {
        await ctx.reply(
          `You only have ${c(formatUsdc(balance))}. Enter a lower amount.`,
          { parse_mode: "HTML", reply_markup: buildWithdrawCancelKeyboard() }
        );
        return true;
      }
      await saveWithdrawState(ctx.from.id, { step: "address", amount });
      await ctx.reply(buildWalletWithdrawAddressText(amount), { parse_mode: "HTML", reply_markup: buildWithdrawCancelKeyboard() });
      return true;
    }

    if (withdrawState.step === "address") {
      const address = messageText.trim();
      if (!isValidSolanaAddress(address)) {
        await ctx.reply("That Solana address doesn't look right. Please double-check and try again.", {
          reply_markup: buildWithdrawCancelKeyboard(),
        });
        return true;
      }
      await clearWithdrawState(ctx.from.id);
      try {
        await requestFantasyWalletWithdrawal({ telegramId: ctx.from.id, destinationAddress: address, amount: withdrawState.amount });
        await processFantasyWalletWithdrawals();
        await ctx.reply(buildWalletWithdrawalRequestedText({ amount: withdrawState.amount, destinationAddress: address }), {
          parse_mode: "HTML",
          reply_markup: buildWalletKeyboard(),
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Something went wrong.";
        await ctx.reply(msg, { reply_markup: buildWalletKeyboard() });
      }
      return true;
    }
  }

  if (!(await hasPendingFantasyCustomFundAmount(ctx.from.id))) {
    return false;
  }

  const amount = parseWalletNairaAmountInput(messageText);

  if (amount === null) {
    await ctx.reply(buildWalletNairaCustomAmountText(), {
      parse_mode: "HTML",
      reply_markup: buildWalletNairaCustomAmountKeyboard(),
    });
    return true;
  }

  const amountError = getWalletNairaAmountError(amount);

  if (amountError) {
    await ctx.reply(amountError, {
      parse_mode: "HTML",
      reply_markup: buildWalletNairaCustomAmountKeyboard(),
    });
    return true;
  }

  try {
    const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await ctx.reply(orderText, {
      parse_mode: "HTML",
      reply_markup: buildWalletNairaOrderKeyboard(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await ctx.reply(message, {
      reply_markup: buildWalletNairaCustomAmountKeyboard(),
    });
  }

  return true;
}

export async function handleWallet(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "address" || subcommand === "refresh") {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    await renderWalletView(ctx, ctx.from.id, { refresh: true });
    return;
  }

  if (subcommand === "withdraw") {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const amount = Number.parseFloat(args[1] ?? "");
    const destinationAddress = args[2]?.trim() ?? "";

    if (!Number.isFinite(amount) || amount <= 0 || !destinationAddress) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(buildWalletWithdrawAmountText(balance), {
        parse_mode: "HTML",
        reply_markup: buildWithdrawCancelKeyboard(),
      });
      return;
    }

    if (!isValidSolanaAddress(destinationAddress)) {
      await ctx.reply("That Solana address doesn't look right. Please double-check and try again.");
      return;
    }

    try {
      await requestFantasyWalletWithdrawal({
        telegramId: ctx.from.id,
        destinationAddress,
        amount,
      });
      await processFantasyWalletWithdrawals();
      await ctx.reply(
        buildWalletWithdrawalRequestedText({ amount, destinationAddress }),
        { parse_mode: "HTML", reply_markup: buildWalletKeyboard() }
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      const normalized = message.toLowerCase();
      if (normalized.includes("insufficient wallet balance")) {
        const balance = await getBalance(ctx.from.id);
        await ctx.reply(buildArenaInsufficientBalanceText(amount, balance), {
          parse_mode: "HTML",
          reply_markup: buildInsufficientBalanceKeyboard(),
        });
        return;
      }
      await ctx.reply(message);
    }

    return;
  }

  if (subcommand === "deposit-cross") {
    await ctx.reply("Use the 🌐 Other chain button in your wallet to deposit from another chain.", {
      reply_markup: buildWalletKeyboard(),
    });
    return;
  }

  if (subcommand === "fund-ngn") {
    const amount = Number.parseFloat(args[1] ?? "");
    const amountError = getWalletNairaAmountError(amount);

    if (amountError) {
      await ctx.reply(amountError, {
        parse_mode: "HTML",
        reply_markup: buildWalletNairaPickerKeyboard(),
      });
      return;
    }

    try {
      await clearPendingFantasyCustomFundAmount(ctx.from.id);
      const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
      await ctx.reply(orderText, {
        parse_mode: "HTML",
        reply_markup: buildWalletNairaOrderKeyboard(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Something went wrong.";
      await ctx.reply(message, {
        reply_markup: buildWalletNairaPickerKeyboard(),
      });
    }

    return;
  }

  await ctx.reply(buildWalletCommandHelpText(), {
    parse_mode: "HTML",
    reply_markup: buildWalletKeyboard(),
  });
}

// ── Offramp (USDC → NGN) ─────────────────────────────────────────────────────

function buildOfframpHelpText(): string {
  return [
    "💸 Offramp USDC → Naira",
    "",
    `Minimum: ${c(`${PAJCASH_OFFRAMP_MIN_USDC} USDC`)}`,
    "",
    `Step ${c("1")} — Enter your Nigerian bank account number.`,
    `Step ${c("2")} — Confirm the account name.`,
    `Step ${c("3")} — Enter the USDC amount to convert.`,
    "",
    "The USDC must be in your in-bot wallet on-chain.",
    "Your balance is debited after the transfer is submitted.",
    "PajCash sends Naira directly to your bank account.",
  ].join("\n");
}

function buildOfframpCancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("❌ Cancel", OFFRAMP_CANCEL);
}

function buildOfframpConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Confirm", OFFRAMP_CONFIRM)
    .text("❌ Cancel", OFFRAMP_CANCEL);
}

function buildOfframpOrderText(input: {
  orderId: string;
  usdcAmount: number;
  fiatAmount: number;
  accountName: string;
  accountNumber: string;
  bankName: string;
  fundingSignature: string;
}): string {
  return [
    "✅ Withdrawal submitted!",
    "",
    `${c(formatNairaCompact(input.fiatAmount))} is on its way to your bank.`,
    "",
    `USDC sent: ${c(formatUsdc(input.usdcAmount))}`,
    `🏦 ${escapeHtml(input.accountName)}`,
    `   ${c(input.accountNumber)}  ·  ${escapeHtml(input.bankName)}`,
    "",
    `Reference: ${c(input.orderId)}`,
    `Signature: ${c(input.fundingSignature)}`,
  ].join("\n");
}

export async function handleOfframpNgn(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  await clearOfframpSession(ctx.from.id);
  await clearPendingFantasyCustomFundAmount(ctx.from.id);

  const balance = await getBalance(ctx.from.id);

  if (balance < PAJCASH_OFFRAMP_MIN_USDC) {
    await ctx.reply(
      [
        `💸 Not enough USDC to offramp.`,
        "",
        `Minimum:         ${c(formatUsdc(PAJCASH_OFFRAMP_MIN_USDC))}`,
        `Your balance:    ${c(formatUsdc(balance))}`,
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: buildWalletKeyboard() }
    );
    return;
  }

  await saveOfframpSession(ctx.from.id, { step: "awaiting_bank_account" });
  await ctx.reply(
    [
      buildOfframpHelpText(),
      "",
      "Enter your Nigerian bank account number:",
    ].join("\n"),
    { parse_mode: "HTML", reply_markup: buildOfframpCancelKeyboard() }
  );
}

export async function handleFundNgn(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const amount = Number.parseFloat((ctx.message?.text ?? "").split(/\s+/)[1] ?? "");

  if (!Number.isFinite(amount) || amount <= 0) {
    await ctx.reply(buildWalletNairaHelpText(), {
      parse_mode: "HTML",
      reply_markup: buildWalletNairaPickerKeyboard(),
    });
    return;
  }

  const amountError = getWalletNairaAmountError(amount);

  if (amountError) {
    await ctx.reply(amountError, {
      parse_mode: "HTML",
      reply_markup: buildWalletNairaPickerKeyboard(),
    });
    return;
  }

  try {
    await clearPendingFantasyCustomFundAmount(ctx.from.id);
    const orderText = await createWalletNairaOrderText(ctx.from.id, amount);
    await ctx.reply(orderText, {
      parse_mode: "HTML",
      reply_markup: buildWalletNairaOrderKeyboard(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    await ctx.reply(message, {
      reply_markup: buildWalletNairaPickerKeyboard(),
    });
  }
}

export async function handleWithdraw(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const amount = Number.parseFloat(args[0] ?? "");
  const destinationAddress = args[1]?.trim() ?? "";

  // No args — start interactive flow
  if (!Number.isFinite(amount) || amount <= 0 || !destinationAddress) {
    const balance = await getBalance(ctx.from.id);
    await saveWithdrawState(ctx.from.id, { step: "amount" });
    await ctx.reply(buildWalletWithdrawAmountText(balance), {
      parse_mode: "HTML",
      reply_markup: buildWithdrawCancelKeyboard(),
    });
    return;
  }

  if (!isValidSolanaAddress(destinationAddress)) {
    await ctx.reply("That Solana address doesn't look right. Please double-check and try again.");
    return;
  }

  try {
    await requestFantasyWalletWithdrawal({
      telegramId: ctx.from.id,
      destinationAddress,
      amount,
    });
    await processFantasyWalletWithdrawals();
    await ctx.reply(
      buildWalletWithdrawalRequestedText({
        amount,
        destinationAddress,
      }),
      {
        parse_mode: "HTML",
        reply_markup: buildWalletKeyboard(),
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Something went wrong.";
    const normalized = message.toLowerCase();

    if (normalized.includes("insufficient wallet balance")) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(buildArenaInsufficientBalanceText(amount, balance), {
        parse_mode: "HTML",
        reply_markup: buildInsufficientBalanceKeyboard(),
      });
      return;
    }

    await ctx.reply(message);
  }
}

export async function handleHelp(ctx: Context): Promise<void> {
  if (!ctx.from) {
    await ctx.reply(buildLeagueHelpText(), { parse_mode: "HTML" });
    return;
  }

  const question = (ctx.message?.text ?? "").split(/\s+/).slice(1).join(" ").trim();

  if (question) {
    await ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => null);
    const answer = await handleSupportQuestion(question, ctx.from.id);
    await ctx.reply(answer);
    return;
  }

  await ctx.reply(buildLeagueHelpText(), {
    parse_mode: "HTML",
    ...(buildChartCommandKeyboard()
      ? { reply_markup: buildChartCommandKeyboard() }
      : {}),
  });
}

export async function handleChart(ctx: Context): Promise<void> {
  await replyChartCommand(ctx);
}

export async function handleCreate(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "create");
}

export async function handleJoin(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "join");
}

export async function handleLive(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "live");
}

export async function handleBoard(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "board");
}

export async function handleStatus(ctx: Context): Promise<void> {
  await handleLeagueAlias(ctx, "status");
}

async function handleLeagueAlias(
  ctx: Context,
  subcommand: "create" | "join" | "live" | "board" | "status"
): Promise<void> {
  const messageText = ctx.message?.text ?? "";
  const command = messageText.split(/\s+/)[0] ?? "";
  const args = messageText.slice(command.length).trim();

  if (ctx.message) {
    ctx.message.text = `/league ${subcommand}${args ? ` ${args}` : ""}`;
  }

  await handleLeague(ctx);
}

export async function handleLeague(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand) {
    await renderArenaStatusList(ctx, ctx.from.id);
    return;
  }

  if (subcommand === "create") {
    const entryFee = Number.parseFloat(args[1] ?? "");
    const durationHours = Number.parseInt(args[2] ?? "", 10);

    if (!Number.isFinite(entryFee)) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(buildCreateArenaPickerText(balance), {
        parse_mode: "HTML",
        reply_markup: buildCreateArenaPickerKeyboard(ctx.from.id),
      });
      return;
    }

    if (!Number.isInteger(durationHours)) {
      const balance = await getBalance(ctx.from.id);
      await ctx.reply(
        buildCreateArenaDurationText({
          balance,
          entryFee,
        }),
        {
          parse_mode: "HTML",
          reply_markup: buildCreateArenaDurationKeyboard(entryFee),
        }
      );
      return;
    }

    try {
      const game = await createFantasyLeagueGame(ctx.from.id, entryFee, durationHours);
      const shareUrl = await getArenaInviteShareUrl(ctx, {
        code: game.code,
        entryFee: game.entry_fee,
      });

      await ctx.reply(
        buildFantasyCreateSuccessText({
          code: game.code,
          prizePool: game.prize_pool,
          virtualStack: game.virtual_start_balance,
          roundsUntilStart: getApproxRoundsUntil(game.start_at),
          durationHours: getGameDurationHours(game),
        }),
        {
          parse_mode: "HTML",
          reply_markup: buildFantasyCreateSuccessKeyboard(shareUrl),
        }
      );
    } catch (error) {
      await replyFantasyCreateError(ctx, error, entryFee);
    }

    return;
  }

  if (subcommand === "join") {
    const code = args[1]?.trim().toUpperCase();

    if (!code) {
      await savePendingJoinCodeEntry(ctx.from.id);
      await ctx.reply(
        "Enter the arena code to join:",
        { reply_markup: new InlineKeyboard().text("❌ Cancel", START_LOBBY) }
      );
      return;
    }

    try {
      await presentJoinPreview(ctx, ctx.from.id, code);
    } catch (error) {
      await replyFantasyJoinError(ctx, error, code);
    }

    return;
  }

  if (subcommand === "live") {
    const code = await resolveArenaLiveCode(ctx.from.id, args[1]);

    if (!code) {
      await ctx.reply("Please provide an arena code. Example: /league live ABC123");
      return;
    }

    try {
      const view = await getFantasyLeagueStatusView(ctx.from.id, code);
      const snapshot =
        view.game.status === "active" && Date.parse(view.game.end_at) > Date.now()
          ? await getCurrentRoundSnapshot("BTC")
          : null;

      await ctx.reply(
        buildArenaLiveText({
          view,
          snapshot,
        }),
        {
          parse_mode: "HTML",
          reply_markup: buildArenaLiveKeyboard({
            code,
            canCatchUp: Boolean(view.me && view.me.place > 1),
            marketUrl: snapshot?.pricing?.url,
            tradeWindowOpen: (() => {
              if (!snapshot) return false;
              const open = Date.parse(snapshot.round.openingDate);
              const close = Date.parse(snapshot.round.closingDate);
              return Date.now() < open + (close - open) * 0.2;
            })(),
          }),
        }
      );
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }

    return;
  }

  if (subcommand === "board") {
    const code = args[1]?.trim().toUpperCase();

    if (!code) {
      await ctx.reply("Please provide an arena code. Example: /league board ABC123");
      return;
    }

    try {
      const view = await getFantasyLeagueStatusView(ctx.from.id, code);
      await ctx.reply(await getFantasyLeagueBoardText(code, ctx.from.id), {
        reply_markup: buildArenaBoardKeyboard({
          code,
          canCatchUp: Boolean(view.me && view.me.place > 1),
        }),
      });
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }

    return;
  }

  if (subcommand === "status") {
    const code = args[1]?.trim().toUpperCase();

    if (!code) {
      await ctx.reply("Please provide an arena code. Example: /league status ABC123");
      return;
    }

    try {
      const view = await getFantasyLeagueStatusView(ctx.from.id, code);
      const settledTrades =
        (view.me?.wins ?? 0) + (view.me?.losses ?? 0);
      const accuracyText =
        settledTrades > 0
          ? `${view.me?.wins ?? 0}/${settledTrades} (${roundMoney(
              ((view.me?.wins ?? 0) / settledTrades) * 100
            )}%)`
          : "0/0 (0%)";
      const lastRoundText = view.lastTrade
        ? `${escapeHtml(view.lastTrade.direction)} ${
            view.lastTrade.outcome === "WIN"
              ? "✅"
              : view.lastTrade.outcome === "LOSS"
                ? "❌"
                : "•"
          }  ${view.lastTrade.outcome === "WIN" ? c(`+${formatMoney(view.lastTrade.payout)}`) : ""}`.trim()
        : "No trades yet";

      await ctx.reply(
        [
          `Arena ${c(view.game.code)}  •  ${escapeHtml(view.game.status.toUpperCase())}`,
          "",
          `Your position: ${
            view.me ? c(`#${view.me.place} of ${view.memberCount}`) : "Not joined"
          }`,
          `Stack: ${c(formatWholeMoney(view.me?.virtual_balance ?? view.game.virtual_start_balance))}  (${c(formatSignedPercent(
            view.me
              ? ((view.me.virtual_balance - view.game.virtual_start_balance) /
                  view.game.virtual_start_balance) *
                  100
              : 0
          ))})`,
          `Rounds left: ${c(`~${view.roundsLeft}  (~${view.roundsLeft * 15} min)`)}`,
          `Prize if game ends now: ${c(formatMoney(view.prizeIfEndedNow))}`,
          "",
          `Last round: ${lastRoundText}`,
          `Accuracy: ${c(accuracyText)}`,
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("Full leaderboard", `arena:board:${view.game.code}`)
            .text("🏟 Back to lobby", ARENA_BACK_TO_LOBBY),
        }
      );
    } catch (error) {
      await replyArenaLookupError(ctx, error);
    }

    return;
  }

  await ctx.reply(buildLeagueHelpText(), { parse_mode: "HTML" });
}

export async function handleFantasyLeagueTrade(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery?.data) {
    return;
  }

  const callbackData = ctx.callbackQuery.data;
  const { chatId, messageId } = getPromptMessageRef(ctx);

  if (callbackData.startsWith("flt:reset:r:")) {
    const ref = callbackData.slice("flt:reset:r:".length);
    const reset = resetFantasyTradePromptToDirection(ref, chatId, messageId);
    if (reset) {
      await editTradePromptMessage(ctx, reset.text, reset.keyboard);
    }
    return;
  }

  if (callbackData.startsWith("flt:b:")) {
    try {
      const directionSelection = await buildFantasyTradeStakeSelection({
        telegramId: ctx.from.id,
        callbackData,
        chatId,
        messageId,
      });

      await editTradePromptMessage(
        ctx,
        directionSelection.text,
        directionSelection.keyboard
      );
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";

      if (isWarmRoundCloseError(error)) {
        clearFantasyTradePromptState(chatId, messageId);
        await editTradePromptMessage(ctx, buildRoundClosedText());
        return;
      }

      if (message) {
        await ctx.reply(message);
        return;
      }

      throw error;
    }
  }

  try {
    const result = await placeFantasyTradeFromCallbackData({
      telegramId: ctx.from.id,
      callbackData,
    });

    clearFantasyTradePromptState(chatId, messageId);
    await editTradePromptMessage(ctx, buildTradeLockedText(result), buildTradeLockedKeyboard(result.game.code), "HTML");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const normalized = message.toLowerCase();

    if (isWarmRoundCloseError(error)) {
      clearFantasyTradePromptState(chatId, messageId);
      await editTradePromptMessage(ctx, buildRoundClosedText());
      return;
    }

    if (normalized.includes("already placed a fantasy trade")) {
      clearFantasyTradePromptState(chatId, messageId);
      await editTradePromptMessage(ctx, buildTradeAlreadyLockedText());
      return;
    }

    if (message) {
      await ctx.reply(message);
      return;
    }

    throw error;
  }
}

export async function handleFantasyJoinConfirm(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const code = await loadPendingFantasyLeagueJoin(ctx.from.id);

  if (!code) {
    await ctx.reply("This invitation has expired. Use /league join CODE to try again.");
    return;
  }

  try {
    const game = await joinFantasyLeagueGame(ctx.from.id, code);
    await clearPendingFantasyLeagueJoin(ctx.from.id);
    const balance = await getBalance(ctx.from.id);
    const leaderboard = await getFantasyLeagueDetailsByCode(game.code);
    const shareUrl = await getArenaInviteShareUrl(ctx, {
      code: game.code,
      entryFee: game.entry_fee,
    });

    await editTradePromptMessage(
      ctx,
      buildFantasyJoinSuccessText({
        code: game.code,
        virtualBalance: game.virtual_start_balance,
        playBalance: balance,
        prizePool: leaderboard.game.prize_pool,
        playerCount: leaderboard.memberCount,
        roundsUntilStart: getApproxRoundsUntil(game.start_at),
        durationHours: getGameDurationHours(game),
      }),
      buildFantasyJoinSuccessKeyboard(shareUrl),
      "HTML"
    );
  } catch (error) {
    await replyFantasyJoinError(ctx, error, code);
  }
}

export async function handleFantasyJoinDecline(ctx: Context): Promise<void> {
  if (!ctx.from) {
    return;
  }

  const code = await loadPendingFantasyLeagueJoin(ctx.from.id);

  if (!code) {
    await ctx.reply("This invitation has expired. Use /league join CODE to try again.");
    return;
  }

  await clearPendingFantasyLeagueJoin(ctx.from.id);
  await ctx.reply(
    `No problem. You can join anytime before the arena starts with /league join ${code}.`
  );
}


export async function handleAdminWithdraw(ctx: Context): Promise<void> {
  if (!ctx.from) return
  if (ctx.from.id !== Number(process.env.ADMIN_USER_ID)) {
    await ctx.reply("⛔ Unauthorized.")
    return
  }
  const args = (ctx.message?.text ?? "").split(/\s+/).slice(1)
  const amount = Number.parseFloat(args[0] ?? "")
  const destination = args[1]?.trim() ?? ""
  if (!Number.isFinite(amount) || amount < 0.5 || !destination) {
    await ctx.reply("Usage: /adminwithdraw <amount> <solana_address>\nMinimum: $0.50")
    return
  }
  try {
    const result = await transferTreasuryUsdc({ destinationAddress: destination, amount })
    await ctx.reply(`✅ Sent $${amount} USDC to ${destination}\nSignature: ${result.signature}`)
  } catch (error) {
    await ctx.reply(`❌ Transfer failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── Prediction Market handlers ────────────────────────────────────────────────

// /createmarket <closes_in_hours> <question...>
// e.g. /createmarket 72 Will ADC sue Peter Obi before September?
export async function handleCreateMarket(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  if (ctx.from.id !== Number(process.env.ADMIN_USER_ID)) {
    await ctx.reply("⛔ Unauthorized.");
    return;
  }

  const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const hours = Number.parseFloat(parts[0] ?? "");
  const question = parts.slice(1).join(" ").trim();

  if (!Number.isFinite(hours) || hours <= 0 || !question) {
    await ctx.reply("Usage: /createmarket <closes_in_hours> <question>\nExample: /createmarket 72 Will ADC sue Peter Obi before September?");
    return;
  }

  const closesAt = new Date(Date.now() + hours * 3_600_000);
  const market = await createMarket({ question, closesAt, createdBy: ctx.from.id });

  const text = buildMarketText(market);
  const keyboard = new InlineKeyboard()
    .text("✅ YES", `pm:yes:${market.id}`)
    .text("❌ NO", `pm:no:${market.id}`);

  // Broadcast to all users
  const users = await listAllUsers();
  const sent: { chat_id: number; message_id: number }[] = [];

  for (const user of users) {
    try {
      const msg = await ctx.api.sendMessage(user.telegram_id, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
      sent.push({ chat_id: user.telegram_id, message_id: msg.message_id });
    } catch {
      // User may have blocked the bot — skip silently
    }
  }

  await saveBroadcastMessageIds(market.id, sent);
  await ctx.reply(`✅ Market created and broadcast to ${sent.length} users.\nID: \`${market.id}\``, { parse_mode: "Markdown" });
}

// /resolvemarket <market_id> <YES|NO>
export async function handleResolveMarket(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  if (ctx.from.id !== Number(process.env.ADMIN_USER_ID)) {
    await ctx.reply("⛔ Unauthorized.");
    return;
  }

  const parts = (ctx.message?.text ?? "").split(/\s+/).slice(1);
  const marketId = parts[0]?.trim() ?? "";
  const outcome = parts[1]?.toUpperCase().trim() as "YES" | "NO" | undefined;

  if (!marketId || (outcome !== "YES" && outcome !== "NO")) {
    await ctx.reply("Usage: /resolvemarket <market_id> <YES|NO>");
    return;
  }

  const { market, payouts } = await resolveMarket({ marketId, outcome });
  const text = buildMarketText(market);
  const voided = (market as typeof market & { _voided?: boolean })._voided === true;

  // Update broadcast messages to show resolved state (no buttons)
  if (market.broadcast_message_ids) {
    const ids = JSON.parse(market.broadcast_message_ids) as { chat_id: number; message_id: number }[];
    for (const { chat_id, message_id } of ids) {
      await ctx.api.editMessageText(chat_id, message_id, text, { parse_mode: "Markdown" }).catch(() => null);
    }
  }

  if (voided) {
    // Notify everyone their stake was refunded
    for (const { telegram_id, payout } of payouts) {
      await ctx.api.sendMessage(
        telegram_id,
        `↩️ *Market voided.* No opposing bets were placed, so your $${payout.toFixed(2)} USDC stake has been refunded.`,
        { parse_mode: "Markdown" }
      ).catch(() => null);
    }
    await ctx.reply(`↩️ Market voided — no opposing pool. ${payouts.length} player(s) refunded.`);
    return;
  }

  // Notify winners
  for (const { telegram_id, payout } of payouts) {
    await ctx.api.sendMessage(
      telegram_id,
      `🏆 *You won!* The market resolved *${outcome}*.\nYou received *$${payout.toFixed(2)} USDC* in your wallet.`,
      { parse_mode: "Markdown" }
    ).catch(() => null);
  }

  await ctx.reply(`✅ Market resolved as *${outcome}*. ${payouts.length} winner(s) paid out.`, { parse_mode: "Markdown" });
}

// Callback: pm:yes:<id> or pm:no:<id> — show amount selection
export async function handleMarketBet(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const [, side, marketId] = data.split(":");
  if (!marketId || (side !== "yes" && side !== "no")) return;

  const betSide = side.toUpperCase() as "YES" | "NO";

  const market = await getMarket(marketId);
  if (!market) { await ctx.answerCallbackQuery({ text: "Market not found.", show_alert: true }); return; }
  if (market.status !== "open" || new Date(market.closes_at) < new Date()) {
    await ctx.answerCallbackQuery({ text: "This market is no longer accepting bets.", show_alert: true }); return;
  }
  const existing = await getUserBet(marketId, ctx.from.id);
  if (existing) {
    await ctx.answerCallbackQuery({ text: `You already bet ${existing.side} on this market.`, show_alert: true }); return;
  }

  await savePendingMarketBet(ctx.from.id, { marketId, side: betSide });

  const odds = calcOdds(market.yes_pool, market.no_pool);
  const prob = betSide === "YES" ? odds.yes : odds.no;
  const keyboard = new InlineKeyboard()
    .text("₦500", `pma:500:${marketId}:${side}`).text("₦1,000", `pma:1000:${marketId}:${side}`).row()
    .text("₦5,000", `pma:5000:${marketId}:${side}`).text("Custom ✏️", `pma:custom:${marketId}:${side}`);

  const pricePerShare = Math.round(prob * 100);
  const payoutPerShare = 100;

  await ctx.reply(
    `${betSide === "YES" ? "✅" : "❌"} <b>Bet ${escapeHtml(betSide)}</b> — ${c(`₦${pricePerShare}/share`)}\n\n` +
    `<b>${escapeHtml(market.question)}</b>\n\n` +
    `Each share costs ${c(`₦${pricePerShare}`)}. Win ${c(`₦${payoutPerShare}`)} per share if correct.\n\n` +
    `How much do you want to bet?`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

// Callback: pma:<amount|custom>:<market_id>:<side>
export async function handleMarketBetAmount(ctx: Context): Promise<void> {
  if (!ctx.from) return;
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  // pma:amount:marketId:side  — but marketId is a UUID with dashes so split carefully
  const amountStr = parts[1];
  const side = parts[parts.length - 1] as "yes" | "no";
  const marketId = parts.slice(2, parts.length - 1).join(":");

  if (amountStr === "custom") {
    await savePendingMarketBetCustom(ctx.from.id);
    await ctx.reply(`Enter your bet amount in naira (e.g. ${c("2500")}):`, { parse_mode: "HTML" });
    return;
  }

  const ngnAmount = Number.parseInt(amountStr, 10);
  if (!Number.isFinite(ngnAmount) || ngnAmount <= 0) return;

  await placePredictionBet(ctx, marketId, side.toUpperCase() as "YES" | "NO", ngnAmount);
}

// Text input: custom NGN amount for pending market bet
export async function handleMarketBetCustom(ctx: Context): Promise<boolean> {
  if (!ctx.from) return false;
  if (!(await hasPendingMarketBetCustom(ctx.from.id))) return false;

  const text = (ctx.message?.text ?? "").replace(/[^0-9]/g, "");
  const ngnAmount = Number.parseInt(text, 10);

  if (!Number.isFinite(ngnAmount) || ngnAmount < 500) {
    await ctx.reply(`Minimum bet is ${c("₦500")}. Enter a valid amount:`, { parse_mode: "HTML" });
    return true;
  }

  await clearPendingMarketBetCustom(ctx.from.id);

  const pending = await loadPendingMarketBet(ctx.from.id);
  if (!pending) { await ctx.reply("Session expired. Please tap YES or NO again."); return true; }

  await placePredictionBet(ctx, pending.marketId, pending.side, ngnAmount);
  return true;
}

// Shared bet placement logic
async function placePredictionBet(ctx: Context, marketId: string, side: "YES" | "NO", ngnAmount: number): Promise<void> {
  if (!ctx.from) return;
  const usdcAmount = Math.round((ngnAmount / NGN_PER_USD) * 1_000_000) / 1_000_000;

  try {
    const { market: updated } = await placeBet({ marketId, telegramId: ctx.from.id, side, amount: usdcAmount });
    await clearPendingMarketBet(ctx.from.id);

    const odds = calcOdds(updated.yes_pool, updated.no_pool);
    const prob = side === "YES" ? odds.yes : odds.no;
    await ctx.reply(
      `✅ <b>Bet placed!</b>\n\n<b>${escapeHtml(side)}</b> on "${escapeHtml(updated.question)}"\n${c(`₦${ngnAmount.toLocaleString()}`)} (${c(`~$${usdcAmount.toFixed(2)} USDC`)}) @ ${c(formatOdds(prob))}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : "Failed to place bet."}`);
  }
}

// ── Bayse Markets (/markets) ──────────────────────────────────────────────────

const BAYSE_MARKETS_CACHE_KEY = "bayse:markets:cache";
const BAYSE_MARKETS_CACHE_TTL = 300; // 5 minutes
const BAYSE_BET_STATE_TTL = 10 * 60;
const MARKETS_AUTO_DELETE_MS = 60_000;

const CATEGORY_EMOJI: Record<string, string> = {
  politics: "🇳🇬",
  sports: "⚽",
  entertainment: "🎬",
  crypto: "₿",
  business: "💼",
  "social media": "📱",
  culture: "🎭",
};

// Fixed category list shown to users regardless of what Bayse returns
const FIXED_CATEGORIES = ["CRYPTO", "POLITICS", "SPORTS", "ENTERTAINMENT", "SOCIAL MEDIA", "CULTURE"];

function categoryEmoji(category: string): string {
  return CATEGORY_EMOJI[category.toLowerCase()] ?? "📊";
}

function normalizeCategoryKey(value: unknown): string {
  if (typeof value !== "string") return "UNKNOWN";
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : "UNKNOWN";
}

function formatNgnPrice(price: number): string {
  return `₦${Math.round(price * 100)}`;
}

async function getCachedBayseEvents(): Promise<BayseEvent[]> {
  try {
    const cached = await redis.get(BAYSE_MARKETS_CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown;
      if (Array.isArray(parsed)) return parsed as BayseEvent[];
    }
  } catch { /* ignore */ }

  // Try twice — Bayse relay occasionally has transient 5xx on first hit
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const events = await listBayseEvents({ size: 50 });
      if (events.length > 0) {
        redis.set(BAYSE_MARKETS_CACHE_KEY, JSON.stringify(events), "EX", BAYSE_MARKETS_CACHE_TTL).catch(() => null);
      }
      return events;
    } catch (err) {
      lastError = err;
      console.error(`[bayse] list events failed (attempt ${attempt}/2):`, err instanceof Error ? err.message : err);
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
    }
  }
  throw lastError;
}

// ── Step 1: Category picker ───────────────────────────────────────────────────

function buildCategoryPickerText(): string {
  return "📊 <b>Markets</b>  ·  Pick a category:";
}

function buildCategoryPickerKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(`${categoryEmoji("crypto")} Crypto`, "bm:cat:CRYPTO")
    .text(`${categoryEmoji("politics")} Politics`, "bm:cat:POLITICS")
    .text(`${categoryEmoji("sports")} Sports`, "bm:cat:SPORTS")
    .row()
    .text(`${categoryEmoji("entertainment")} Entertainment`, "bm:cat:ENTERTAINMENT")
    .text(`${categoryEmoji("social media")} Social Media`, "bm:cat:SOCIAL MEDIA")
    .text(`${categoryEmoji("culture")} Culture`, "bm:cat:CULTURE");
  return kb;
}

// ── Step 2: Top 3 markets ─────────────────────────────────────────────────────

/**
 * Reframes a vague question by injecting the top candidate/team name.
 * "Who wins the 2027 Election?" + "Peter Obi" → "Will Peter Obi win the 2027 Election?"
 * If outcome1Label is already "Yes"/"No" or blank, returns the original title unchanged.
 */
function reframeTitleWithCandidate(title: string, outcome1Label: string): string {
  const label = outcome1Label.trim();
  // Skip generic binary labels
  if (!label || /^(yes|no|true|false)$/i.test(label)) return title;

  // Already starts with the candidate name — don't double-inject
  if (title.toLowerCase().includes(label.toLowerCase())) return title;

  // Strip leading "Who " / "Which " question words and reframe
  const stripped = title
    .replace(/^who\s+(will\s+)?(win|be|become|get|take|lead|win\s+the)?/i, "")
    .replace(/^which\s+(team|country|player|candidate|party)\s+(will\s+)?/i, "")
    .trim();

  // Build "Will [Name] [rest]?" — capitalise first letter of rest
  const rest = stripped.replace(/\?$/, "").trim();
  const restLower = rest.charAt(0).toLowerCase() + rest.slice(1);
  return `Will ${label} ${restLower}?`;
}

function buildCategoryMarketsText(category: string, events: BayseEvent[]): string {
  const lines = [`${categoryEmoji(category)} <b>${escapeHtml(category)}</b>  ·  Top markets\n`];

  events.forEach((e, i) => {
    const m = e.markets[0]!;
    const reframed = reframeTitleWithCandidate(e.title, m.outcome1Label);
    const liq = e.liquidity >= 1_000_000
      ? `₦${(e.liquidity / 1_000_000).toFixed(1)}M`
      : e.liquidity >= 1_000
      ? `₦${Math.round(e.liquidity / 1_000)}K`
      : `₦${Math.round(e.liquidity)}`;

    lines.push(
      `<b>${i + 1}. ${escapeHtml(reframed)}</b>`,
      `YES ${c(formatNgnPrice(m.outcome1Price))}  ·  NO ${c(formatNgnPrice(m.outcome2Price))}  ·  ${c(liq)} pool`,
      ""
    );
  });

  return lines.join("\n").trim();
}

function buildCategoryMarketsKeyboard(category: string, events: BayseEvent[]): InlineKeyboard {
  const kb = new InlineKeyboard();

  events.forEach((e, i) => {
    const m = e.markets[0]!;
    const n = i + 1;
    const shortKey = `${e.id.slice(0, 4)}${m.id.slice(0, 4)}`;
    redis.set(`bayse:mkt:${shortKey}`, `${e.id}:${m.id}`, "EX", 3600).catch(() => null);

    kb.text(`${n} · YES ${formatNgnPrice(m.outcome1Price)}`, `bm:bet:yes:${shortKey}`)
      .text(`${n} · NO ${formatNgnPrice(m.outcome2Price)}`, `bm:bet:no:${shortKey}`)
      .row();
  });

  kb.text("← Categories", "bm:list");
  return kb;
}

// ── Step 3: Quote screen ──────────────────────────────────────────────────────

function buildQuoteText(event: BayseEvent, market: BayseMarket, side: "yes" | "no"): string {
  const price = side === "yes" ? market.outcome1Price : market.outcome2Price;
  const reframed = reframeTitleWithCandidate(event.title, market.outcome1Label);
  const sideLabel = side === "yes" ? "YES" : "NO";
  const minBet = Math.ceil(price * 100);
  return [
    `${side === "yes" ? "✅" : "❌"} <b>${escapeHtml(reframed)}</b>`,
    "",
    `Buying <b>${sideLabel}</b> at ${c(formatNgnPrice(price))}/share`,
    `Win ${c("₦100")} per share if correct`,
    "",
    `How much? Type a Naira amount (min ${c(`₦${minBet}`)})`,
    `e.g. ${c("2000")} → ${Math.floor(2000 / (price * 100))} shares → win ${c(`₦${Math.floor(2000 / (price * 100)) * 100}`)}`,
  ].join("\n");
}

// ── Step 4: Receipt ───────────────────────────────────────────────────────────

function buildReceiptText(input: {
  side: string;
  eventTitle: string;
  ngnAmount: number;
  shares: number;
  priceNgn: number;
  payoutNgn: number;
  orderId: string | null;
  positionId: string;
}): string {
  return [
    `✅ <b>Order placed!</b>`,
    "",
    `Market:   ${escapeHtml(input.eventTitle)}`,
    `Side:     <b>${escapeHtml(input.side.toUpperCase())}</b>`,
    `Stake:    ${c(`₦${input.ngnAmount.toLocaleString()}`)}`,
    `Shares:   ${c(`${input.shares} @ ${formatNgnPrice(input.priceNgn / 100)}`)}`,
    `Payout:   ${c(`₦${input.payoutNgn.toLocaleString()}`)} if correct`,
    "",
    `Order ID: ${c(input.orderId ?? input.positionId)}`,
  ].join("\n");
}

// ── Redis state ───────────────────────────────────────────────────────────────

async function saveBayseBetState(telegramId: number, state: {
  eventId: string; marketId: string; side: string;
}): Promise<void> {
  await redis.set(`bayse:bet:${telegramId}`, JSON.stringify(state), "EX", BAYSE_BET_STATE_TTL);
}

async function loadBayseBetState(telegramId: number): Promise<{ eventId: string; marketId: string; side: string } | null> {
  const raw = await redis.get(`bayse:bet:${telegramId}`);
  return raw ? JSON.parse(raw) : null;
}

async function clearBayseBetState(telegramId: number): Promise<void> {
  await redis.del(`bayse:bet:${telegramId}`);
}

async function saveBayseCustomBetPending(telegramId: number): Promise<void> {
  await redis.set(`bayse:bet:custom:${telegramId}`, "1", "EX", BAYSE_BET_STATE_TTL);
}

async function hasBayseCustomBetPending(telegramId: number): Promise<boolean> {
  return (await redis.get(`bayse:bet:custom:${telegramId}`)) !== null;
}

async function clearBayseCustomBetPending(telegramId: number): Promise<void> {
  await redis.del(`bayse:bet:custom:${telegramId}`);
}

// ── Core bet placement ────────────────────────────────────────────────────────

async function placeBayseMarketBet(
  ctx: Context,
  eventId: string,
  marketId: string,
  side: "yes" | "no",
  ngnAmount: number
): Promise<void> {
  if (!ctx.from) return;

  const events = await getCachedBayseEvents();
  const event = events.find((e) => e.id === eventId);
  const market = event?.markets.find((m) => m.id === marketId);

  if (!event || !market) {
    await ctx.reply("Market not found or no longer available.");
    return;
  }

  const outcomeId = side === "yes" ? market.outcome1Id : market.outcome2Id;
  const outcomeLabel = side === "yes" ? market.outcome1Label : market.outcome2Label;
  const price = side === "yes" ? market.outcome1Price : market.outcome2Price;
  const shares = sharesForAmount(ngnAmount, price);
  const usdcAmount = ngnToUsdc(ngnAmount);

  if (shares < 1) {
    await ctx.reply(`Minimum bet is ${c(`₦${Math.ceil(price * 100)} (1 share)`) }.`, { parse_mode: "HTML" });
    return;
  }

  const balance = await getBalance(ctx.from.id);
  if (balance < usdcAmount) {
    await ctx.reply(
      `💸 Insufficient balance.\n\nRequired: ${c(`$${usdcAmount.toFixed(4)} USDC`)}\nYour balance: ${c(`$${balance.toFixed(4)} USDC`)}`,
      { parse_mode: "HTML", reply_markup: buildInsufficientBalanceKeyboard() }
    );
    return;
  }

  const debited = await debitBalance(ctx.from.id, usdcAmount, {
    reason: "bayse_market_bet",
    referenceType: "bayse_position",
    idempotencyKey: `baysebet:${ctx.from.id}:${marketId}:${Date.now()}`,
  });

  if (!debited) {
    await ctx.reply("Insufficient balance. Please top up your wallet.", {
      reply_markup: buildInsufficientBalanceKeyboard(),
    });
    return;
  }

  let bayseOrderId: string;
  try {
    const order = await placeBayseOrder({ eventId, marketId, outcomeId, amountNgn: ngnAmount });
    bayseOrderId = order.order.id;
  } catch (err) {
    console.error("[bayse] Order placement failed — refunding user:", err instanceof Error ? err.message : err);
    // Refund the debit — the order never hit Bayse
    await creditBalance(ctx.from.id, usdcAmount, {
      reason: "bayse_order_failed_refund",
      referenceType: "bayse_position",
      idempotencyKey: `bayserefund:${ctx.from.id}:${marketId}:${Date.now()}`,
    }).catch((e) => console.error("[bayse] Refund failed:", e));
    await ctx.reply(
      `❌ Order failed — your balance has been refunded.\n\n${err instanceof Error ? escapeHtml(err.message) : "Bayse market unavailable."}`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const position = await insertBaysePosition({
    telegramId: ctx.from.id,
    eventId,
    eventSlug: event.slug,
    eventTitle: event.title,
    marketId,
    outcomeId,
    outcomeLabel,
    amountNgn: ngnAmount,
    amountUsdc: usdcAmount,
    shares,
    priceAtBet: price,
  });

  if (bayseOrderId) {
    await supabase.from("bayse_positions").update({ bayse_order_id: bayseOrderId }).eq("id", position.id);
  }

  const payoutNgn = potentialPayoutNgn(shares);
  const receipt = buildReceiptText({
    side,
    eventTitle: event.title,
    ngnAmount,
    shares,
    priceNgn: Math.round(price * 100),
    payoutNgn,
    orderId: bayseOrderId,
    positionId: position.id,
  });

  const sent = await ctx.reply(receipt, { parse_mode: "HTML" });

  // Auto-delete receipt after 60s
  setTimeout(() => {
    ctx.api.deleteMessage(sent.chat.id, sent.message_id).catch(() => null);
  }, MARKETS_AUTO_DELETE_MS);
}

// ── Exported handlers ─────────────────────────────────────────────────────────

export async function handleMarkets(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const msgKey = `bayse:markets:msg:${ctx.from.id}`;
  const stored = await redis.get(msgKey).catch(() => null);

  if (stored) {
    const { chatId, messageId } = JSON.parse(stored) as { chatId: number; messageId: number };
    try {
      await ctx.api.editMessageText(chatId, messageId, buildCategoryPickerText(), {
        parse_mode: "HTML",
        reply_markup: buildCategoryPickerKeyboard(),
      });
      return;
    } catch {
      // Message too old or deleted — fall through to send a new one
    }
  }

  const sent = await ctx.reply(buildCategoryPickerText(), {
    parse_mode: "HTML",
    reply_markup: buildCategoryPickerKeyboard(),
  });

  await redis.set(msgKey, JSON.stringify({ chatId: sent.chat.id, messageId: sent.message_id }), "EX", 3600).catch(() => null);
}

export async function handleMarketsCallback(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.callbackQuery?.data) return;
  const data = ctx.callbackQuery.data;

  // ── Category picker (back) ────────────────────────────────────────────────
  if (data === "bm:list") {
    await editTradePromptMessage(ctx, buildCategoryPickerText(), buildCategoryPickerKeyboard(), "HTML");
    return;
  }

  // ── Category selected → show top 3 markets ────────────────────────────────
  if (data.startsWith("bm:cat:")) {
    const category = normalizeCategoryKey(data.slice("bm:cat:".length));
    try {
      const events = await getCachedBayseEvents();
      const wantedCategory = category.toUpperCase();
      const top3 = events
        .filter((e) =>
          normalizeCategoryKey(e.category) === wantedCategory &&
          Array.isArray(e.markets) &&
          e.markets.length > 0
        )
        .sort(
          (a, b) =>
            (Number.isFinite(b.liquidity) ? b.liquidity : 0) -
            (Number.isFinite(a.liquidity) ? a.liquidity : 0)
        )
        .slice(0, 3);

      if (top3.length === 0) {
        await editTradePromptMessage(
          ctx,
          `No live ${category} markets right now.\n\nPick another category:`,
          buildCategoryPickerKeyboard(),
          "Markdown"
        );
        return;
      }

      await editTradePromptMessage(
        ctx,
        buildCategoryMarketsText(category, top3),
        buildCategoryMarketsKeyboard(category, top3),
        "HTML"
      );
    } catch (err) {
      console.error("[bayse] category load failed:", err instanceof Error ? err.message : err);
      await ctx.reply("Markets are temporarily unavailable. Please try again in a minute.");
    }
    return;
  }

  // ── YES/NO tapped → show quote, prompt for amount ─────────────────────────
  if (data.startsWith("bm:bet:")) {
    const parts = data.split(":");
    const side = parts[2] as "yes" | "no";
    const shortKey = parts[3] ?? "";
    if (!shortKey || (side !== "yes" && side !== "no")) return;

    // Resolve short key → full eventId:marketId
    const stored = await redis.get(`bayse:mkt:${shortKey}`);
    if (!stored) { await ctx.reply("Market session expired. Please tap /markets again."); return; }
    const [eventId, marketId] = stored.split(":");
    if (!eventId || !marketId) return;

    const events = await getCachedBayseEvents().catch(() => [] as BayseEvent[]);
    const event = events.find((e) => e.id === eventId);
    const market = event?.markets?.find((m) => m.id === marketId);
    if (!event || !market) { await ctx.reply("Market no longer available."); return; }

    await saveBayseBetState(ctx.from.id, { eventId, marketId, side });
    await saveBayseCustomBetPending(ctx.from.id);

    await editTradePromptMessage(
      ctx,
      buildQuoteText(event, market, side),
      new InlineKeyboard().text(
        "← Back",
        `bm:cat:${FIXED_CATEGORIES.includes(normalizeCategoryKey(event.category)) ? normalizeCategoryKey(event.category) : "CRYPTO"}`
      ),
      "HTML"
    );
    return;
  }
}

export async function handleBayseCustomBetInput(ctx: Context): Promise<boolean> {
  if (!ctx.from) return false;
  if (!(await hasBayseCustomBetPending(ctx.from.id))) return false;

  const text = (ctx.message?.text ?? "").replace(/[^0-9]/g, "");
  const ngnAmount = Number.parseInt(text, 10);

  if (!Number.isFinite(ngnAmount) || ngnAmount < 100) {
    await ctx.reply(`Minimum bet is ${c("₦100")}. Enter a valid Naira amount:`, { parse_mode: "HTML" });
    return true;
  }

  await clearBayseCustomBetPending(ctx.from.id);
  const state = await loadBayseBetState(ctx.from.id);
  if (!state) { await ctx.reply("Session expired. Tap YES or NO again."); return true; }

  await clearBayseBetState(ctx.from.id);
  await placeBayseMarketBet(ctx, state.eventId, state.marketId, state.side as "yes" | "no", ngnAmount);
  return true;
}
