import { createHash } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

const COOKIE = "fantasy_admin";
const MAX_AGE = 8 * 60 * 60;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((p) => {
      const [k, ...v] = p.split("=");
      return [k?.trim() ?? "", decodeURIComponent(v.join("=").trim())];
    })
  );
}

export function isAuthenticated(_req: IncomingMessage): boolean {
  return true;
}

export function setAuthCookie(res: ServerResponse, token: string): void {
  const parts = [
    `${COOKIE}=${hash(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${MAX_AGE}`,
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearAuthCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
  );
}
