import { describe, it, expect } from "vitest";
import { getBalanceSource } from "./league.ts";

describe("getBalanceSource", () => {
  it("routes Sports to connected_base_market_balance", () => {
    expect(getBalanceSource("SPORTS")).toBe("connected_base_market_balance");
    expect(getBalanceSource("sports")).toBe("connected_base_market_balance");
  });

  it("routes World Cup to connected_base_market_balance", () => {
    expect(getBalanceSource("WORLD CUP")).toBe("connected_base_market_balance");
    expect(getBalanceSource("world cup")).toBe("connected_base_market_balance");
  });

  it("routes Crypto to connected_base_market_balance", () => {
    expect(getBalanceSource("CRYPTO")).toBe("connected_base_market_balance");
  });

  it("routes unknown categories to connected_base_market_balance (default)", () => {
    expect(getBalanceSource("FUTURE_CATEGORY")).toBe("connected_base_market_balance");
    expect(getBalanceSource("")).toBe("connected_base_market_balance");
  });
});
