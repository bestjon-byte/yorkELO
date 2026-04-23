
-- Create parallel tables for York Mixed League

CREATE TABLE IF NOT EXISTS mixed_players (
  name text PRIMARY KEY,
  rating double precision NOT NULL,
  rubbers_played integer NOT NULL,
  last_played text,
  first_div integer,
  current_div integer,
  club text,
  rank integer
);

CREATE TABLE IF NOT EXISTS mixed_match_history (
  id SERIAL PRIMARY KEY,
  player_name text NOT NULL,
  seq integer NOT NULL,
  date text,
  fixture_id text,
  rubber_order integer,
  rating double precision,
  result character,
  partner text,
  opp1 text,
  opp2 text,
  team text,
  opp_team text,
  my_games integer,
  opp_games integer,
  division integer,
  season integer
);

CREATE TABLE IF NOT EXISTS mixed_player_stats (
  player_name text PRIMARY KEY,
  best_partner jsonb,
  worst_partner jsonb,
  nemesis jsonb,
  nemesis_pair jsonb,
  nemesis_club jsonb,
  best_club jsonb
);

CREATE TABLE IF NOT EXISTS mixed_elo_fixtures (
  fixture_id text PRIMARY KEY,
  season integer,
  division integer,
  date text,
  time text,
  home_team text,
  away_team text,
  home_games integer,
  away_games integer,
  status text,
  is_conceded boolean
);

CREATE TABLE IF NOT EXISTS mixed_aliases (
  variant_name text PRIMARY KEY,
  canonical_name text NOT NULL
);

-- Indices for performance
CREATE INDEX IF NOT EXISTS idx_mixed_match_history_player ON mixed_match_history(player_name);
CREATE INDEX IF NOT EXISTS idx_mixed_match_history_fixture ON mixed_match_history(fixture_id);
