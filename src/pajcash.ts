import { randomUUID } from "crypto";

import { config } from "./config.ts";
import {
  createPajCashOnrampRecord,
  createPajCashOfframpRecord,
  getPajCashOnrampByOrderId,
  upsertPajCashOnrampStatus,
  type PajCashOnramp,
} from "./db/pajcash.ts";
import { getBalance, debitBalance } from "./db/balances.ts";
import { getFantasyWalletByOwnerAddress, type FantasyWallet } from "./db/wallets.ts";
import {
  ensureFantasyWallet,
  getFantasyWalletOnChainUsdcBalance,
  syncFantasyWalletDeposits,
  transferFantasyWalletUsdc,
} from "./solana-wallet.ts";
import { withUserWalletOperationLock } from "./utils/user-wallet-operation-lock.ts";

interface PajCashVerifyResponse {
  recipient: string;
  isActive: string;
  expiresAt: string;
  token: string;
}

interface PajCashOnrampOrderResponse {
  id: string;
  accountNumber: string;
  accountName: string;
  amount: number;
  fiatAmount: number;
  bank: string;
  rate: number;
  recipient: string;
  currency: string;
  mint: string;
  fee?: number;
}

interface PajCashOfframpOrderResponse {
  id: string;
  address: string;
  mint: string;
  currency: string;
  amount: number;
  fiatAmount: number;
  rate: number;
  fee: number;
}

export interface PajCashBank {
  id: string;
  code: string;
  name: string;
  logo?: string;
  country: string;
}

export interface PajCashBankAccountConfirmation {
  accountName: string;
  accountNumber: string;
  bank: {
    id: string;
    name: string;
    code: string;
    country: string;
  };
}

interface PajCashTransactionResponse {
  id: string;
  address?: string;
  signature?: string;
  mint?: string;
  currency?: string;
  amount?: number;
  usdcAmount?: number;
  fiatAmount?: number;
  sender?: string;
  recipient?: string;
  rate?: number;
  status: string;
  transactionType?: string;
  createdAt?: string | Date;
  fee?: number;
}

export interface PajCashWebhookPayload {
  id: string;
  address?: string;
  signature?: string;
  mint?: string;
  currency?: string;
  amount?: number;
  usdcAmount?: number;
  fiatAmount?: number;
  sender?: string;
  recipient?: string;
  rate?: number;
  status: string;
  transactionType?: string;
}

const PAJCASH_REQUEST_TIMEOUT_MS = 20_000;
const USDC_EPSILON = 0.000001;

function roundFiat(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundUsdc(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function amountsMatch(left: number, right: number): boolean {
  return Math.abs(roundUsdc(left) - roundUsdc(right)) <= USDC_EPSILON;
}

function getPajCashBaseUrl(): string {
  if (config.PAJCASH_ENV === "staging") {
    return "https://api-staging.paj.cash";
  }

  if (config.PAJCASH_ENV === "local") {
    return "http://localhost:3000";
  }

  return "https://api.paj.cash";
}

function getRequiredPajCashApiKey(): string {
  const value = config.PAJCASH_API_KEY?.trim() ?? "";

  if (!value) {
    throw new Error("PAJCASH_API_KEY is missing.");
  }

  return value;
}

function getRequiredPajCashSessionRecipient(): string {
  const value = config.PAJCASH_SESSION_RECIPIENT?.trim() ?? "";

  if (!value) {
    throw new Error("PAJCASH_SESSION_RECIPIENT is missing.");
  }

  return value;
}

function getRequiredPajCashSessionToken(): string {
  const token = config.PAJCASH_SESSION_TOKEN?.trim() ?? "";

  if (!token) {
    throw new Error(
      "PAJCASH_SESSION_TOKEN is missing. Run `pnpm pajcash:session` to request and verify a PajCash OTP session."
    );
  }

  const expiresAt = config.PAJCASH_SESSION_EXPIRES_AT?.trim() ?? "";

  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);

    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now() + 60_000) {
      throw new Error(
        "PAJCASH session token is expired or about to expire. Run `pnpm pajcash:session` again."
      );
    }
  }

  return token;
}

function getRequiredPajCashWebhookPathSecret(): string {
  const value = config.PAJCASH_WEBHOOK_PATH_SECRET?.trim() ?? "";

  if (!value) {
    throw new Error("PAJCASH_WEBHOOK_PATH_SECRET is missing.");
  }

  return value;
}

function getPajCashWebhookBaseUrl(): string {
  const explicit = config.PAJCASH_WEBHOOK_BASE_URL?.trim() ?? "";

  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }

  const fallback = config.WEBHOOK_URL?.trim() ?? "";

  if (fallback) {
    return fallback.replace(/\/+$/, "");
  }

  throw new Error(
    "PAJCASH_WEBHOOK_BASE_URL is missing. Set it to the public base URL that PajCash should call."
  );
}

async function parsePajCashResponse<T>(response: Response): Promise<T> {
  const rawText = await response.text();
  let parsed: unknown = {};

  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as T;
    } catch {
      if (!response.ok) {
        throw new Error(rawText || `PajCash request failed with ${response.status}`);
      }

      throw new Error(
        `PajCash returned an invalid JSON response with status ${response.status}.`
      );
    }
  }

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in (parsed as object)
        ? String((parsed as Record<string, unknown>).message)
        : rawText || `PajCash request failed with ${response.status}`;

    throw new Error(message);
  }

  return parsed as T;
}

async function pajCashRequest<T>(
  path: string,
  input: {
    method?: "GET" | "POST";
    token?: string;
    apiKey?: string;
    body?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (input.token) {
    headers.Authorization = `Bearer ${input.token}`;
  }

  if (input.apiKey) {
    headers["x-api-key"] = input.apiKey;
  }

  const response = await fetch(`${getPajCashBaseUrl()}${path}`, {
    method: input.method ?? "GET",
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
    signal: AbortSignal.timeout(PAJCASH_REQUEST_TIMEOUT_MS),
  });

  return parsePajCashResponse<T>(response);
}

function normalizePajCashStatus(status: string): string {
  const normalized = status.trim().toUpperCase();

  if (!normalized) {
    throw new Error("PajCash webhook payload is missing status.");
  }

  return normalized;
}

function isPajCashCompletedStatus(status: string | null | undefined): boolean {
  return (status ?? "").trim().toUpperCase() === "COMPLETED";
}

export function getPajCashWebhookUrl(): string {
  return `${getPajCashWebhookBaseUrl()}/webhook/pajcash/${getRequiredPajCashWebhookPathSecret()}`;
}

export async function initiatePajCashSession(): Promise<{ email?: string; phone?: string }> {
  const recipient = getRequiredPajCashSessionRecipient();
  const apiKey = getRequiredPajCashApiKey();
  const body = recipient.includes("@")
    ? { email: recipient }
    : { phone: recipient };

  return pajCashRequest("/pub/initiate", {
    method: "POST",
    apiKey,
    body,
  });
}

export async function verifyPajCashSessionOtp(
  otp: string
): Promise<PajCashVerifyResponse> {
  const trimmedOtp = otp.trim();

  if (!trimmedOtp) {
    throw new Error("OTP is required.");
  }

  const recipient = getRequiredPajCashSessionRecipient();
  const apiKey = getRequiredPajCashApiKey();
  const body = recipient.includes("@")
    ? {
        email: recipient,
        otp: trimmedOtp,
        device: {
          uuid: `fantasybot-${Date.now()}`,
          device: "Fantasy Bot Server",
          os: process.platform,
          browser: "Node.js",
        },
      }
    : {
        phone: recipient,
        otp: trimmedOtp,
        device: {
          uuid: `fantasybot-${Date.now()}`,
          device: "Fantasy Bot Server",
          os: process.platform,
          browser: "Node.js",
        },
      };

  return pajCashRequest<PajCashVerifyResponse>("/pub/verify", {
    method: "POST",
    apiKey,
    body,
  });
}

export async function createFantasyPajCashOnramp(input: {
  telegramId: number;
  fiatAmount: number;
}): Promise<PajCashOnramp> {
  const sessionToken = getRequiredPajCashSessionToken();
  const wallet = await ensureFantasyWallet(input.telegramId);
  const fiatAmount = roundFiat(input.fiatAmount);

  if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) {
    throw new Error("Fiat amount must be greater than zero.");
  }

  const requestBody: Record<string, unknown> = {
    fiatAmount,
    currency: "NGN",
    recipient: wallet.owner_address,
    mint: config.SOLANA_USDC_MINT,
    chain: "SOLANA",
    webhookURL: getPajCashWebhookUrl(),
  };

  if (config.PAJCASH_BUSINESS_USDC_FEE !== undefined) {
    requestBody.businessUSDCFee = config.PAJCASH_BUSINESS_USDC_FEE;
  }

  const order = await pajCashRequest<PajCashOnrampOrderResponse>("/pub/onramp", {
    method: "POST",
    token: sessionToken,
    body: requestBody,
  });

  return createPajCashOnrampRecord({
    orderId: order.id,
    telegramId: input.telegramId,
    recipientAddress: wallet.owner_address,
    mint: order.mint,
    chain: "SOLANA",
    currency: order.currency,
    bankName: order.bank,
    accountName: order.accountName,
    accountNumber: order.accountNumber,
    fiatAmount: order.fiatAmount,
    expectedUsdcAmount: order.amount,
    rate: order.rate,
    fee: order.fee ?? config.PAJCASH_BUSINESS_USDC_FEE ?? 0,
    rawPayload: order as unknown as Record<string, unknown>,
  });
}

export async function getPajCashTransaction(
  orderId: string
): Promise<PajCashTransactionResponse> {
  return pajCashRequest<PajCashTransactionResponse>(`/pub/transactions/${orderId}`, {
    token: getRequiredPajCashSessionToken(),
  });
}

export async function getBanks(): Promise<PajCashBank[]> {
  return pajCashRequest<PajCashBank[]>("/pub/bank", {
    token: getRequiredPajCashSessionToken(),
  });
}

export async function confirmBankAccount(input: {
  bankId: string;
  accountNumber: string;
}): Promise<PajCashBankAccountConfirmation> {
  return pajCashRequest<PajCashBankAccountConfirmation>(
    `/pub/bank-account/confirm?bankId=${encodeURIComponent(input.bankId)}&accountNumber=${encodeURIComponent(input.accountNumber)}`,
    { token: getRequiredPajCashSessionToken() }
  );
}

export const PAJCASH_OFFRAMP_MIN_USDC = 0.5;

async function finalizeOfframpInternalDebit(input: {
  telegramId: number;
  usdcAmount: number;
  requestId: string;
  orderId: string;
  debitIdempotencyKey: string;
  userWalletAddress: string;
  pajcashDepositAddress: string;
  pajcashFundingSignature: string;
}): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const debited = await debitBalance(input.telegramId, input.usdcAmount, {
        reason: "offramp_request",
        referenceType: "pajcash_offramp",
        idempotencyKey: input.debitIdempotencyKey,
        metadata: {
          requestId: input.requestId,
          requestedUsdcAmount: input.usdcAmount,
          orderId: input.orderId,
          userWalletAddress: input.userWalletAddress,
          pajcashDepositAddress: input.pajcashDepositAddress,
          pajcashFundingSignature: input.pajcashFundingSignature,
        },
      });

      if (debited) {
        return;
      }

      lastError = new Error(
        "USDC transfer to PajCash succeeded, but the internal wallet balance could not be finalized."
      );
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Unknown internal debit error during PajCash offramp.");
    }
  }

  throw lastError ?? new Error("Failed to finalize the PajCash offramp debit.");
}

export interface PajCashOfframpResult {
  order: PajCashOnramp;
  fundingSignature: string;
  destinationUsdcAta: string;
}

export async function createFantasyPajCashOfframp(input: {
  telegramId: number;
  bankId: string;
  accountNumber: string;
  usdcAmount: number;
}): Promise<PajCashOfframpResult> {
  return withUserWalletOperationLock({
    telegramId: input.telegramId,
    reason: "pajcash_offramp",
    task: async () => {
      const usdcAmount = roundUsdc(input.usdcAmount);

      if (!Number.isFinite(usdcAmount) || usdcAmount < PAJCASH_OFFRAMP_MIN_USDC) {
        throw new Error(`Minimum offramp amount is ${PAJCASH_OFFRAMP_MIN_USDC} USDC.`);
      }

      const wallet = await ensureFantasyWallet(input.telegramId);
      await syncFantasyWalletDeposits(wallet);

      const [internalBalance, onChainBalance] = await Promise.all([
        getBalance(input.telegramId),
        getFantasyWalletOnChainUsdcBalance({ wallet }),
      ]);

      if (internalBalance < usdcAmount) {
        throw new Error(`Insufficient wallet balance. Available: ${internalBalance} USDC.`);
      }

      if (onChainBalance + USDC_EPSILON < usdcAmount) {
        throw new Error(
          `Insufficient on-chain in-bot wallet balance. Available on-chain: ${onChainBalance} USDC.`
        );
      }

      const sessionToken = getRequiredPajCashSessionToken();
      const requestId = randomUUID();
      const debitIdempotencyKey = `pajcash_offramp:${requestId}:debit`;

      const requestBody: Record<string, unknown> = {
        bank: input.bankId,
        accountNumber: input.accountNumber,
        currency: "NGN",
        amount: usdcAmount,
        mint: config.SOLANA_USDC_MINT,
        chain: "SOLANA",
        webhookURL: getPajCashWebhookUrl(),
      };

      if (config.PAJCASH_BUSINESS_USDC_FEE !== undefined) {
        requestBody.businessUSDCFee = config.PAJCASH_BUSINESS_USDC_FEE;
      }

      let order: PajCashOfframpOrderResponse | null = null;
      let record: PajCashOnramp | null = null;
      let transfer:
        | {
            signature: string;
            destinationUsdcAta: string;
          }
        | null = null;

      try {
        order = await pajCashRequest<PajCashOfframpOrderResponse>("/pub/offramp", {
          method: "POST",
          token: sessionToken,
          body: requestBody,
        });

        if (!order.address?.trim()) {
          throw new Error("PajCash offramp order did not return a deposit address.");
        }

        if (!amountsMatch(order.amount, usdcAmount)) {
          throw new Error(
            `PajCash quoted ${roundUsdc(order.amount)} USDC for a ${usdcAmount} USDC offramp.`
          );
        }

        record = await createPajCashOfframpRecord({
          orderId: order.id,
          telegramId: input.telegramId,
          senderAddress: wallet.owner_address,
          depositAddress: order.address,
          mint: order.mint,
          chain: "SOLANA",
          currency: order.currency,
          bankId: input.bankId,
          accountNumber: input.accountNumber,
          usdcAmount,
          fiatAmount: order.fiatAmount,
          rate: order.rate,
          fee: order.fee ?? config.PAJCASH_BUSINESS_USDC_FEE ?? 0,
          rawPayload: {
            ...order,
            botRequestId: requestId,
            botFundingSource: wallet.owner_address,
            requestedUsdcAmount: usdcAmount,
            debitIdempotencyKey,
          } as Record<string, unknown>,
        });

        transfer = await transferFantasyWalletUsdc({
          wallet,
          destinationAddress: order.address,
          amount: usdcAmount,
        });

        await finalizeOfframpInternalDebit({
          telegramId: input.telegramId,
          usdcAmount,
          requestId,
          orderId: order.id,
          debitIdempotencyKey,
          userWalletAddress: wallet.owner_address,
          pajcashDepositAddress: order.address,
          pajcashFundingSignature: transfer.signature,
        });

        try {
          record = await upsertPajCashOnrampStatus({
            orderId: record.order_id,
            telegramId: record.telegram_id,
            recipientAddress: record.recipient_address,
            sender: record.sender,
            mint: record.mint,
            chain: record.chain,
            currency: record.currency,
            bankName: record.bank_name,
            accountName: record.account_name,
            accountNumber: record.account_number,
            fiatAmount: record.fiat_amount,
            expectedUsdcAmount: record.expected_usdc_amount,
            actualUsdcAmount: record.actual_usdc_amount,
            rate: record.rate,
            fee: record.fee,
            status: record.status,
            transactionType: record.transaction_type,
            pajSignature: record.paj_signature,
            rawPayload: {
              ...record.raw_payload,
              botFundingSignature: transfer.signature,
              botFundingDestinationUsdcAta: transfer.destinationUsdcAta,
              botFundingSentAt: new Date().toISOString(),
              botInternalDebitFinalizedAt: new Date().toISOString(),
            },
          });
        } catch (error) {
          console.warn("[pajcash] Failed to persist offramp funding metadata:", error);
        }

        return {
          order: record,
          fundingSignature: transfer.signature,
          destinationUsdcAta: transfer.destinationUsdcAta,
        };
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "Unknown PajCash offramp error.";

        if (record) {
          try {
            await upsertPajCashOnrampStatus({
              orderId: record.order_id,
              telegramId: record.telegram_id,
              recipientAddress: record.recipient_address,
              sender: record.sender,
              mint: record.mint,
              chain: record.chain,
              currency: record.currency,
              bankName: record.bank_name,
              accountName: record.account_name,
              accountNumber: record.account_number,
              fiatAmount: record.fiat_amount,
              expectedUsdcAmount: record.expected_usdc_amount,
              actualUsdcAmount: record.actual_usdc_amount,
              rate: record.rate,
              fee: record.fee,
              status: record.status,
              transactionType: record.transaction_type,
              pajSignature: record.paj_signature,
              rawPayload: {
                ...record.raw_payload,
                ...(transfer
                  ? {
                      botFundingSignature: transfer.signature,
                      botFundingDestinationUsdcAta: transfer.destinationUsdcAta,
                      botFundingSentAt: new Date().toISOString(),
                    }
                  : {}),
                botFundingFailedAt: new Date().toISOString(),
                botFundingError: reason,
              },
            });
          } catch (updateError) {
            console.warn("[pajcash] Failed to persist offramp error metadata:", updateError);
          }
        }

        if (transfer) {
          throw new Error(
            `USDC was sent from your in-bot wallet to PajCash, but the offramp could not be finalized automatically. ${reason} Contact support with order ${order?.id ?? requestId}.`
          );
        }

        throw new Error(`Offramp could not be created. ${reason}`);
      }
    },
  });
}

function getPayloadUsdcAmount(
  payload: PajCashWebhookPayload | PajCashTransactionResponse
): number | null {
  if (typeof payload.usdcAmount === "number" && Number.isFinite(payload.usdcAmount)) {
    return roundUsdc(payload.usdcAmount);
  }

  if (typeof payload.amount === "number" && Number.isFinite(payload.amount)) {
    return roundUsdc(payload.amount);
  }

  return null;
}

async function resolveOnrampWallet(
  payload: PajCashWebhookPayload
): Promise<FantasyWallet | null> {
  const recipient = payload.recipient?.trim() ?? "";

  if (!recipient) {
    return null;
  }

  return getFantasyWalletByOwnerAddress(recipient);
}

export async function reconcilePajCashWebhook(
  payload: PajCashWebhookPayload
): Promise<PajCashOnramp | null> {
  if (!payload.id) {
    throw new Error("PajCash webhook payload is missing id.");
  }

  const payloadStatus = normalizePajCashStatus(payload.status);
  const transactionType = payload.transactionType?.toUpperCase() ?? "";

  if (transactionType && transactionType !== "ON_RAMP" && transactionType !== "OFF_RAMP") {
    return null;
  }

  const existing = await getPajCashOnrampByOrderId(payload.id);
  const preservedExpectedUsdcAmount =
    existing && existing.expected_usdc_amount > 0
      ? existing.expected_usdc_amount
      : getPayloadUsdcAmount(payload);
  let wallet =
    existing?.recipient_address
      ? await getFantasyWalletByOwnerAddress(existing.recipient_address)
      : await resolveOnrampWallet(payload);

  const initialActualUsdcAmount = getPayloadUsdcAmount(payload);
  const initialAmountMismatch =
    (existing?.transaction_type ?? transactionType) === "OFF_RAMP" &&
    preservedExpectedUsdcAmount !== null &&
    initialActualUsdcAmount !== null &&
    !amountsMatch(preservedExpectedUsdcAmount, initialActualUsdcAmount);

  if (initialAmountMismatch) {
    console.error(
      `[pajcash] Offramp amount mismatch for order ${payload.id}: ` +
        `expected ${preservedExpectedUsdcAmount}, got ${initialActualUsdcAmount}.`
    );
  }

  let record = await upsertPajCashOnrampStatus({
    orderId: payload.id,
    telegramId: existing?.telegram_id ?? wallet?.telegram_id ?? null,
    recipientAddress: payload.recipient ?? existing?.recipient_address ?? null,
    sender: payload.sender ?? existing?.sender ?? null,
    mint: payload.mint ?? existing?.mint ?? null,
    chain: "SOLANA",
    currency: payload.currency ?? existing?.currency ?? "NGN",
    actualUsdcAmount: initialActualUsdcAmount,
    expectedUsdcAmount: preservedExpectedUsdcAmount,
    fiatAmount:
      typeof payload.fiatAmount === "number" ? roundFiat(payload.fiatAmount) : null,
    rate: typeof payload.rate === "number" ? roundUsdc(payload.rate) : null,
    status: payloadStatus,
    transactionType: transactionType || existing?.transaction_type || "ON_RAMP",
    pajSignature: payload.signature ?? existing?.paj_signature ?? null,
    rawPayload: initialAmountMismatch
      ? {
          ...(payload as unknown as Record<string, unknown>),
          botExpectedUsdcAmount: preservedExpectedUsdcAmount,
          botAmountMismatch: true,
        }
      : (payload as unknown as Record<string, unknown>),
  });

  if (!wallet && record.recipient_address) {
    wallet = await getFantasyWalletByOwnerAddress(record.recipient_address);
  }

  try {
    const verified = await getPajCashTransaction(payload.id);
    const verifiedActualUsdcAmount = getPayloadUsdcAmount(verified);
    const verifiedAmountMismatch =
      (record.transaction_type ?? transactionType) === "OFF_RAMP" &&
      record.expected_usdc_amount > 0 &&
      verifiedActualUsdcAmount !== null &&
      !amountsMatch(record.expected_usdc_amount, verifiedActualUsdcAmount);

    if (verifiedAmountMismatch) {
      console.error(
        `[pajcash] Verified offramp amount mismatch for order ${payload.id}: ` +
          `expected ${record.expected_usdc_amount}, got ${verifiedActualUsdcAmount}.`
      );
    }

    record = await upsertPajCashOnrampStatus({
      orderId: payload.id,
      telegramId: record.telegram_id,
      recipientAddress: verified.recipient ?? record.recipient_address,
      sender: verified.sender ?? record.sender,
      mint: verified.mint ?? record.mint,
      chain: "SOLANA",
      currency: verified.currency ?? record.currency,
      actualUsdcAmount: verifiedActualUsdcAmount,
      expectedUsdcAmount:
        record.expected_usdc_amount > 0
          ? record.expected_usdc_amount
          : getPayloadUsdcAmount(verified),
      fiatAmount:
        typeof verified.fiatAmount === "number"
          ? roundFiat(verified.fiatAmount)
          : record.fiat_amount,
      rate: typeof verified.rate === "number" ? roundUsdc(verified.rate) : record.rate,
      fee: typeof verified.fee === "number" ? roundUsdc(verified.fee) : record.fee,
      status: normalizePajCashStatus(verified.status),
      transactionType: verified.transactionType ?? record.transaction_type,
      pajSignature: verified.signature ?? record.paj_signature,
      rawPayload: verifiedAmountMismatch
        ? {
            ...(verified as unknown as Record<string, unknown>),
            botExpectedUsdcAmount: record.expected_usdc_amount,
            botAmountMismatch: true,
          }
        : (verified as unknown as Record<string, unknown>),
    });

    if (!wallet && record.recipient_address) {
      wallet = await getFantasyWalletByOwnerAddress(record.recipient_address);
    }
  } catch (error) {
    console.warn("[pajcash] Transaction verification failed:", error);
  }

  if (wallet && isPajCashCompletedStatus(record.status) && (record.transaction_type ?? "ON_RAMP") === "ON_RAMP") {
    await syncFantasyWalletDeposits(wallet).catch((error) => {
      console.warn("[pajcash] Deposit sync after webhook failed:", error);
    });
  }

  return record;
}
