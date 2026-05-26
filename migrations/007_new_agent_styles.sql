-- Add 5 new agent styles: scalper, momentum_only, mean_revert, odds_follower, balanced

-- 1. Update ai_arena_bots CHECK constraint to allow new styles
ALTER TABLE ai_arena_bots
  DROP CONSTRAINT IF EXISTS ai_arena_bots_style_check;

ALTER TABLE ai_arena_bots
  ADD CONSTRAINT ai_arena_bots_style_check
  CHECK (style IN (
    'aggressive','conservative','random','trend','contrarian',
    'scalper','momentum_only','mean_revert','odds_follower','balanced'
  ));

-- 2. Seed 5 new bots into ai_arena_bots
INSERT INTO fantasy_users (telegram_id, username, is_bot)
VALUES
  (-1006, 'Razor',    TRUE),
  (-1007, 'Bullet',   TRUE),
  (-1008, 'Bouncer',  TRUE),
  (-1009, 'Bookman',  TRUE),
  (-1010, 'Zen',      TRUE)
ON CONFLICT (telegram_id) DO NOTHING;

INSERT INTO ai_arena_bots (telegram_id, display_name, style)
VALUES
  (-1006, 'Razor',   'scalper'),
  (-1007, 'Bullet',  'momentum_only'),
  (-1008, 'Bouncer', 'mean_revert'),
  (-1009, 'Bookman', 'odds_follower'),
  (-1010, 'Zen',     'balanced')
ON CONFLICT (telegram_id) DO NOTHING;

-- 3. Widen the agent_style CHECK constraint on fantasy_game_members
ALTER TABLE fantasy_game_members
  DROP CONSTRAINT IF EXISTS fantasy_game_members_agent_style_check;

ALTER TABLE fantasy_game_members
  ADD CONSTRAINT fantasy_game_members_agent_style_check
  CHECK (agent_style IN (
    'aggressive','conservative','random','trend','contrarian',
    'scalper','momentum_only','mean_revert','odds_follower','balanced'
  ));
