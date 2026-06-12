/**
 * backfill-historical-fixtures.js
 * One-off: after york_elo_fixtures gained a composite (season, fixture_id) PK,
 * insert the historical fixtures that the old fixture_id-only dedup dropped
 * (older-season members of cross-season id collisions).
 *
 * Uses ignoreDuplicates so existing rows — including current-season data that
 * may be newer than these local JSON files — are left untouched. Historical
 * (past-season) fixtures are immutable, so inserting them is safe.
 */
try { require('dotenv').config({ path: '.env.local' }); } catch (_) {}

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ALL_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];

function buildFixtureRows() {
  const map = new Map();
  for (const year of ALL_SEASONS) {
    const file = `fixtures_${year}.json`;
    if (!fs.existsSync(file)) continue;
    for (const f of JSON.parse(fs.readFileSync(file)).fixtures) {
      let homeGames = null, awayGames = null;
      if (f.rubbers && f.rubbers.length > 0) {
        homeGames = f.rubbers.reduce((s, r) => s + (r.home_games || 0), 0);
        awayGames = f.rubbers.reduce((s, r) => s + (r.away_games || 0), 0);
      }
      const row = {
        fixture_id: String(f.fixture_id),
        season: f.season || year,
        division: f.division,
        date: f.date,
        time: f.time || null,
        home_team: f.home_team,
        away_team: f.away_team,
        home_games: homeGames,
        away_games: awayGames,
        status: (homeGames !== null) ? 'played' : 'upcoming',
        is_conceded: !!(f.skipped && f.reason === 'conceded'),
      };
      map.set(`${row.season}:${row.fixture_id}`, row);
    }
  }
  return Array.from(map.values());
}

async function run() {
  const rows = buildFixtureRows();
  console.log(`Built ${rows.length} (season, fixture_id) rows from local JSON`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const { error, count } = await supabase
      .from('york_elo_fixtures')
      .upsert(chunk, { onConflict: 'season,fixture_id', ignoreDuplicates: true, count: 'exact' });
    if (error) { console.error('Insert error:', error.message); process.exit(1); }
    inserted += count ?? 0;
  }
  console.log(`Inserted ${inserted} missing historical rows (existing rows left untouched)`);

  const { count: total } = await supabase
    .from('york_elo_fixtures').select('*', { count: 'exact', head: true });
  console.log(`york_elo_fixtures now has ${total} rows`);
}

run().catch(err => { console.error('Failed:', err.message); process.exit(1); });
