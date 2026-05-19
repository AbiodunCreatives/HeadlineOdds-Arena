import { randomUUID } from "crypto";

import { redis } from "./rateLimit.ts";

const USER_WALLET_OPERATION_LOCK_TTL_SECONDS = 180;

export const USER_WALLET_OPERATION_BUSY_MESSAGE =
  "Another wallet action is already in progress. Please wait a moment and try again.";

function getUserWalletOperationLockKey(telegramId: number): string {
  return `wallet:operation:lock:${telegramId}`;
}

export async function acquireUserWalletOperationLock(input: {
  telegramId: number;
  reason: string;
  ttlSeconds?: number;
}): Promise<(() => Promise<void>) | null> {
  const lockKey = getUserWalletOperationLockKey(input.telegramId);
  const lockToken = `${input.reason}:${randomUUID()}`;
  const acquired = await redis.set(
    lockKey,
    lockToken,
    "EX",
    input.ttlSeconds ?? USER_WALLET_OPERATION_LOCK_TTL_SECONDS,
    "NX"
  );

  if (!acquired) {
    return null;
  }

  let released = false;

  return async () => {
    if (released) {
      return;
    }

    released = true;
    const currentValue = await redis.get(lockKey);

    if (currentValue === lockToken) {
      await redis.del(lockKey);
    }
  };
}

export async function withUserWalletOperationLock<T>(input: {
  telegramId: number;
  reason: string;
  busyMessage?: string;
  ttlSeconds?: number;
  task: () => Promise<T>;
}): Promise<T> {
  const release = await acquireUserWalletOperationLock({
    telegramId: input.telegramId,
    reason: input.reason,
    ttlSeconds: input.ttlSeconds,
  });

  if (!release) {
    throw new Error(input.busyMessage ?? USER_WALLET_OPERATION_BUSY_MESSAGE);
  }

  try {
    return await input.task();
  } finally {
    await release().catch(() => undefined);
  }
}
