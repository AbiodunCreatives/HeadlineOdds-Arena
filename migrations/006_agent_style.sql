-- Player-owned agent arena: agent_style on fantasy_game_members
-- When set, the round processor auto-trades for this member using the chosen agent strategy.

ALTER TABLE fantasy_game_members
  ADD COLUMN IF NOT EXISTS agent_style TEXT
    CHECK (agent_style IN ('aggressive','conservative','random','trend','contrarian'));
