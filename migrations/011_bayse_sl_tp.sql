-- Add stop loss and take profit price thresholds to bayse_positions
ALTER TABLE bayse_positions
  ADD COLUMN IF NOT EXISTS stop_loss_price   NUMERIC(6,4),  -- close if currentValue/cost ratio drops below this price (0–1)
  ADD COLUMN IF NOT EXISTS take_profit_price NUMERIC(6,4);  -- close if currentValue/cost ratio rises above this price (0–1)
