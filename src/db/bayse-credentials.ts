import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { supabase } from "./client.ts";
import { config } from "../config.ts";

function getEncKey(): Buffer {
  return Buffer.from(config.SOLANA_WALLET_ENCRYPTION_KEY, "hex");
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

function decrypt(stored: string): string {
  const [ivHex, tagHex, ctHex] = stored.split(":");
  const decipher = createDecipheriv("aes-256-gcm", getEncKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(ctHex, "hex")).toString("utf8") + decipher.final("utf8");
}

export async function saveBayseCredentials(
  telegramId: number,
  publicKey: string,
  secretKey: string
): Promise<void> {
  const { error } = await supabase.from("bayse_credentials").upsert({
    telegram_id: telegramId,
    public_key: publicKey,
    secret_key: encrypt(secretKey),
    updated_at: new Date().toISOString(),
  }, { onConflict: "telegram_id" });
  if (error) throw error;
}

export async function getBayseCredentials(
  telegramId: number
): Promise<{ publicKey: string; secretKey: string } | null> {
  const { data, error } = await supabase
    .from("bayse_credentials")
    .select("public_key, secret_key")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    publicKey: data.public_key as string,
    secretKey: decrypt(data.secret_key as string),
  };
}

export async function deleteBayseCredentials(telegramId: number): Promise<void> {
  await supabase.from("bayse_credentials").delete().eq("telegram_id", telegramId);
}
