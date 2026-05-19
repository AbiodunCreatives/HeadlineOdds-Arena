import { config } from "../config.ts";

export async function sendAdminAlert(message: string): Promise<void> {
  const adminId = config.ADMIN_USER_ID;
  const botToken = config.BOT_TOKEN;

  if (!adminId || !botToken || botToken === "dashboard-only-token") {
    return;
  }

  const text = `🚨 *Alert*\n\`\`\`\n${message.slice(0, 3500)}\n\`\`\``;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: adminId,
      text,
      parse_mode: "MarkdownV2",
    }),
  }).catch(() => undefined); // never throw — alerting must not crash the caller
}
