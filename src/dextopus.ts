// Dextopus cross-chain deposit API client
// Base URL: https://swap-api.dextopus.com
// Public endpoints (validate-address) need no auth.
// Quote/deposit endpoints require DEXTOPUS_API_KEY as x-api-key header.
// Amounts are always in smallest unit (1 USDC = 1_000_000)

import { config } from "./config.ts";

const BASE_URL = "https://swap-api.dextopus.com";

export interface DextopusToken {
  chainId: number | string;
  address: string;
  symbol: string;
  decimals: number;
  supportsStaticAddress?: boolean;
}

export interface DextopusQuoteRequest {
  originChainId: number;
  destinationChainId: number;
  originAsset: string;
  destinationAsset: string;
  amount: string; // smallest unit
  recipient: string;
  refundTo: string;
  partnerFees?: Array<{ recipient: string; fee: number }>;
  dry?: boolean;
}

export interface DextopusQuoteResponse {
  depositRequestId: string;
  depositAddress: string;
  amountOut: string;
  expiresInSeconds: number;
  isStaticAddress: boolean;
}

export interface DextopusStatusResponse {
  depositRequestId: string;
  depositAddress: string;
  status: string;
  executionStatus: string;
  originTransactionHashes: string[];
  destinationTransactionHashes: string[];
  isStaticAddress: boolean;
}

export interface DextopusValidateRequest {
  chainType: "evm" | "solana" | "tron" | "bitcoin";
  address: string;
}

export interface DextopusValidateResponse {
  valid: boolean;
  reason?: string;
}

async function dextopusFetch<T>(
  path: string,
  options?: RequestInit & { auth?: boolean }
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string> ?? {}),
  };

  if (options?.auth !== false && config.DEXTOPUS_API_KEY) {
    headers["x-api-key"] = config.DEXTOPUS_API_KEY;
  }

  const { auth: _auth, ...fetchOptions } = options ?? {};

  const res = await fetch(`${BASE_URL}${path}`, {
    ...fetchOptions,
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dextopus ${path} failed: ${res.status} ${body}`);
  }

  return res.json() as Promise<T>;
}

/** Fetch all supported deposit origin chains and tokens. Cache the result. */
let _tokensCache: { data: DextopusToken[]; expiresAt: number } | null = null;
const TOKENS_CACHE_TTL_MS = 5 * 60 * 1000;

export async function getDextopusTokens(
  supportsStaticAddress?: boolean
): Promise<DextopusToken[]> {
  const now = Date.now();
  if (supportsStaticAddress === undefined && _tokensCache && now < _tokensCache.expiresAt) {
    return _tokensCache.data;
  }

  const qs =
    supportsStaticAddress !== undefined
      ? `?supportsStaticAddress=${supportsStaticAddress}`
      : "";
  const envelope = await dextopusFetch<{
    success: boolean;
    chains: Array<{
      chainId: number | string;
      solverCurrencies: Array<{
        symbol: string;
        address: string;
        decimals: number;
        supportsStaticAddress?: boolean;
      }>;
    }>;
  }>(`/api/deposit/tokens${qs}`);

  const result = (envelope.chains ?? []).flatMap((chain) =>
    (chain.solverCurrencies ?? []).map((t) => ({
      chainId: chain.chainId,
      address: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      supportsStaticAddress: t.supportsStaticAddress,
    }))
  );

  if (supportsStaticAddress === undefined) {
    _tokensCache = { data: result, expiresAt: Date.now() + TOKENS_CACHE_TTL_MS };
  }

  return result;
}

/** Get destination options for a given origin asset. */
export async function getDextopusDestinations(params: {
  originAddress?: string;
  originChainId?: number | string;
}): Promise<DextopusToken[]> {
  const qs = new URLSearchParams();
  if (params.originAddress) qs.set("originAddress", params.originAddress);
  if (params.originChainId !== undefined)
    qs.set("originChainId", String(params.originChainId));

  const envelope = await dextopusFetch<{
    success: boolean;
    destinations: Array<{
      currency: string;
      symbol: string;
      blockchain: string;
      destinationChainId: number | string;
      decimals: number;
      supportsStaticAddress?: boolean;
    }>;
  }>(`/api/deposit/destinations?${qs.toString()}`);

  return (envelope.destinations ?? []).map((t) => ({
    chainId: t.destinationChainId,
    address: t.currency,
    symbol: t.symbol,
    decimals: t.decimals,
    supportsStaticAddress: t.supportsStaticAddress,
  }));
}

/** Validate a recipient address format before creating a deposit request. */
export async function validateDextopusAddress(
  req: DextopusValidateRequest
): Promise<DextopusValidateResponse> {
  return dextopusFetch<DextopusValidateResponse>(
    "/api/deposit/validate-address",
    { method: "POST", body: JSON.stringify(req) }
  );
}

/** Create a deposit request. Returns the depositAddress to show the user. */
export async function createDextopusDeposit(
  req: DextopusQuoteRequest
): Promise<DextopusQuoteResponse> {
  return dextopusFetch<DextopusQuoteResponse>("/api/deposit/quote", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** Poll deposit status by depositRequestId. */
export async function getDextopusDepositStatus(
  depositRequestId: string
): Promise<DextopusStatusResponse> {
  return dextopusFetch<DextopusStatusResponse>(
    `/api/deposit/status?depositRequestId=${encodeURIComponent(depositRequestId)}`
  );
}

/** Submit a tx hash for chains that need manual notification. */
export async function submitDextopusTxHash(params: {
  depositRequestId: string;
  depositAddress: string;
  txHash: string;
}): Promise<void> {
  await dextopusFetch("/api/deposit/submit", {
    method: "POST",
    body: JSON.stringify(params),
  });
}
