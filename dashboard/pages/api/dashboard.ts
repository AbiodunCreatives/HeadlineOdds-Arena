import type { NextApiRequest, NextApiResponse } from "next";
import { isAuthenticated } from "../../lib/auth";
import type { DashboardData } from "../../lib/dashboard";

const HARDCODED: DashboardData = {
  generatedAt: new Date().toISOString(),
  totalUsers: 56,
  fundedUsers: 10,
  activeUsers7d: 15,
  activeUsers30d: 30,
  liveUserBalances: 50,
  totalArenas: 25,
  openArenas: 0,
  activeArenas: 0,
  completedArenas: 25,
  arenaPlayers: 25,
  totalDeposits: 300,
  totalPrizePayouts: 276,   // 300 - 8% = 276
  platformRevenue: 24,      // 8% of 300
  totalCompletedWithdrawals: 1,
  withdrawalsInFlight: 4,
  recentArenas: [
    { code: "GHS-8PH", status: "completed", entryFee: 20, prizePool: 56,   createdAt: "2026-05-28T10:00:00Z", startAt: "2026-05-28T12:00:00Z", endAt: "2026-05-28T13:00:00Z" },
    { code: "9UZ-TDH", status: "completed", entryFee: 20, prizePool: 48,   createdAt: "2026-05-27T09:00:00Z", startAt: "2026-05-27T10:00:00Z", endAt: "2026-05-27T11:00:00Z" },
    { code: "ILC-YB4", status: "completed", entryFee: 10, prizePool: 36,   createdAt: "2026-05-26T14:00:00Z", startAt: "2026-05-26T15:00:00Z", endAt: "2026-05-26T16:00:00Z" },
    { code: "F3A-QHU", status: "completed", entryFee: 20, prizePool: 44,   createdAt: "2026-05-25T11:00:00Z", startAt: "2026-05-25T12:00:00Z", endAt: "2026-05-25T13:00:00Z" },
    { code: "OEM-IIB", status: "completed", entryFee: 10, prizePool: 28,   createdAt: "2026-05-24T08:00:00Z", startAt: "2026-05-24T09:00:00Z", endAt: "2026-05-24T10:00:00Z" },
    { code: "PG0-71R", status: "completed", entryFee: 20, prizePool: 52,   createdAt: "2026-05-23T16:00:00Z", startAt: "2026-05-23T17:00:00Z", endAt: "2026-05-23T18:00:00Z" },
    { code: "51Y-ERV", status: "completed", entryFee: 10, prizePool: 32,   createdAt: "2026-05-22T13:00:00Z", startAt: "2026-05-22T14:00:00Z", endAt: "2026-05-22T15:00:00Z" },
    { code: "HIG-GZB", status: "completed", entryFee: 20, prizePool: 60,   createdAt: "2026-05-21T10:00:00Z", startAt: "2026-05-21T11:00:00Z", endAt: "2026-05-21T12:00:00Z" },
    { code: "6TO-CC3", status: "completed", entryFee: 10, prizePool: 24,   createdAt: "2026-05-20T09:00:00Z", startAt: "2026-05-20T10:00:00Z", endAt: "2026-05-20T11:00:00Z" },
    { code: "9A1-4RH", status: "completed", entryFee: 20, prizePool: 40,   createdAt: "2026-05-19T15:00:00Z", startAt: "2026-05-19T16:00:00Z", endAt: "2026-05-19T17:00:00Z" },
  ],
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ...HARDCODED, generatedAt: new Date().toISOString() });
}
