/**
 * migrate-to-supabase.js
 * One-time (and re-runnable) script to push all local JSON data into Supabase.
 * Uses the SERVICE ROLE key for write access.
 *
 * Usage:
 *   node scripts/migrate-to-supabase.js
 *
 * Requires .env.local with:
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=eyJ...
 */

try { require('dotenv').config({ path: '.env.local' }); } catch (_) {}

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const ALL_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];
const CHUNK = 1000;

// ---------------------------------------------------------------------------
// Helpers (mirrors server.js logic)
// ---------------------------------------------------------------------------
function resolveAlias(name, aliases) {
  let r = name; const seen = new Set();
  while (aliases[r] && !seen.has(r)) { seen.add(r); r = aliases[r]; }
  return r;
}

function teamToClub(team) {
  return team.replace(/\s+\d+$/, '').trim();
}

function applyAliases(fixtures, aliases) {
  if (!Object.keys(aliases).length) return fixtures;
  const resolve = n => n ? resolveAlias(n, aliases) : n;
  return fixtures.map(f => ({
    ...f,
    rubbers: f.rubbers.map(r => ({
      ...r,
      home_player1: resolve(r.home_player1),
      home_player2: resolve(r.home_player2),
      away_player1: resolve(r.away_player1),
      away_player2: resolve(r.away_player2),
    })),
  }));
}

function buildDivisionMaps(aliases) {
  const firstDiv = {}, lastDiv = {}, lastClub = {}, lastYear = {};
  for (const year of ALL_SEASONS) {
    const file = `fixtures_${year}.json`;
    if (!fs.existsSync(file)) continue;
    for (const f of JSON.parse(fs.readFileSync(file)).fixtures) {
      const homeClub = teamToClub(f.home_team);
      const awayClub = teamToClub(f.away_team);
      for (const r of f.rubbers) {
        for (const [n, club] of [
          [r.home_player1, homeClub], [r.home_player2, homeClub],
          [r.away_player1, awayClub], [r.away_player2, awayClub],
        ]) {
          if (!n) continue;
          const canon = resolveAlias(n, aliases);
          if (!(canon in firstDiv)) firstDiv[canon] = f.division;
          if (!(canon in lastYear) || year > lastYear[canon]) {
            lastYear[canon] = year;
            lastDiv[canon]  = f.division;
            lastClub[canon] = club;
          }
        }
      }
    }
  }
  return { firstDiv, lastDiv, lastClub };
}

function buildPlayerMatchLogs(aliases) {
  let all = [];
  for (const year of ALL_SEASONS) {
    const file = `fixtures_${year}.json`;
    if (!fs.existsSync(file)) continue;
    all.push(...JSON.parse(fs.readFileSync(file)).fixtures);
  }
  all = applyAliases(all, aliases);
  all.sort((a, b) => new Date(a.date) - new Date(b.date));

  const logs = {};
  for (const fixture of all) {
    for (const r of [...fixture.rubbers].sort((a, b) => a.rubber_order - b.rubber_order)) {
      if (!r.home_player1 || !r.home_player2 || !r.away_player1 || !r.away_player2) continue;
      if (r.winner === null) continue;
      const homeResult = r.winner === 'home' ? 'W' : r.winner === 'away' ? 'L' : 'D';
      const awayResult = r.winner === 'away' ? 'W' : r.winner === 'home' ? 'L' : 'D';
      const base = { date: fixture.date, fixture_id: String(fixture.fixture_id), rubber_order: r.rubber_order, division: fixture.division, season: fixture.season };
      for (const [player, partner] of [[r.home_player1, r.home_player2], [r.home_player2, r.home_player1]]) {
        if (!logs[player]) logs[player] = [];
        logs[player].push({ ...base, result: homeResult, partner, opp1: r.away_player1, opp2: r.away_player2, team: fixture.home_team, opp_team: fixture.away_team, my_games: r.home_games, opp_games: r.away_games });
      }
      for (const [player, partner] of [[r.away_player1, r.away_player2], [r.away_player2, r.away_player1]]) {
        if (!logs[player]) logs[player] = [];
        logs[player].push({ ...base, result: awayResult, partner, opp1: r.home_player1, opp2: r.home_player2, team: fixture.away_team, opp_team: fixture.home_team, my_games: r.away_games, opp_games: r.home_games });
      }
    }
  }
  return logs;
}

function buildPlayerStats(matchLogs) {
  const stats = {};
  for (const [name, log] of Object.entries(matchLogs)) {
    const partnerMap = {}, oppMap = {}, pairMap = {}, clubMap = {};
    for (const e of log) {
      (partnerMap[e.partner] ??= { W:0,L:0,D:0 })[e.result]++;
      for (const opp of [e.opp1, e.opp2]) (oppMap[opp] ??= { W:0,L:0,D:0 })[e.result]++;
      const key = [e.opp1, e.opp2].sort().join('\0');
      (pairMap[key] ??= { W:0,L:0,D:0, names:[e.opp1,e.opp2].sort() })[e.result]++;
      (clubMap[teamToClub(e.opp_team)] ??= { W:0,L:0,D:0 })[e.result]++;
    }
    const pick = (map, minRubbers, bestIsHigh) => {
      let best = null, bestWR = bestIsHigh ? -1 : 2;
      for (const [k, s] of Object.entries(map)) {
        const total = s.W + s.L + s.D;
        if (total < minRubbers) continue;
        const wr = (s.W + s.D * 0.5) / total;
        if (bestIsHigh ? wr > bestWR : wr < bestWR) {
          bestWR = wr;
          best = { key: k, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100), ...(s.names ? { names: s.names } : { name: k }) };
        }
      }
      return best;
    };
    const bestPartner  = pick(partnerMap, 5, true);
    const nemesis      = pick(oppMap, 3, false);
    const rawPair      = pick(pairMap, 3, false);
    const nemesisPair  = rawPair ? { names: rawPair.names, wins: rawPair.wins, losses: rawPair.losses, draws: rawPair.draws, total: rawPair.total, winRate: rawPair.winRate } : null;
    const rawClub      = pick(clubMap, 5, false);
    const nemesisClub  = rawClub ? { name: rawClub.key, wins: rawClub.wins, losses: rawClub.losses, draws: rawClub.draws, total: rawClub.total, winRate: rawClub.winRate } : null;
    if (bestPartner) delete bestPartner.key;
    if (nemesis)     delete nemesis.key;
    stats[name] = { bestPartner, nemesis, nemesisPair, nemesisClub };
  }
  return stats;
}

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------
async function clearTable(table, filterCol) {
  const { error } = await supabase.from(table).delete().not(filterCol, 'is', null);
  if (error) throw new Error(`Clear ${table}: ${error.message}`);
}

async function batchInsert(table, rows, label) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabase.from(table).insert(chunk);
    if (error) throw new Error(`Insert ${table} chunk ${i}: ${error.message}`);
    inserted += chunk.length;
    process.stdout.write(`\r  ${label}: ${inserted}/${rows.length}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
  console.log('Loading local data...');
  const aliases = fs.existsSync('player-aliases.json') ? JSON.parse(fs.readFileSync('player-aliases.json')) : {};

  // Merge in any aliases added via the admin tool (stored in york_aliases)
  const { data: dbAliases } = await supabase.from('york_aliases').select('variant_name, canonical_name');
  for (const { variant_name, canonical_name } of dbAliases || []) aliases[variant_name] = canonical_name;
  if (dbAliases?.length) console.log(`  + ${dbAliases.length} alias(es) from york_aliases table`);

  const ratingsData = JSON.parse(fs.readFileSync('ratings_all.json'));
  const { firstDiv, lastDiv, lastClub } = buildDivisionMaps(aliases);
  const matchLogs   = buildPlayerMatchLogs(aliases);
  const playerStats = buildPlayerStats(matchLogs);

  // ---- Build players rows ----
  const playerRows = ratingsData.leaderboard.map((p, i) => ({
    name:           p.name,
    rating:         p.rating,
    rubbers_played: p.rubbers_played,
    last_played:    p.last_played,
    first_div:      firstDiv[p.name] || null,
    current_div:    lastDiv[p.name]  || null,
    club:           lastClub[p.name] || null,
    rank:           i + 1,
  }));

  // ---- Build match_history rows ----
  const historyRows = [];
  for (const [playerName, eloHistory] of Object.entries(ratingsData.history)) {
    const log = matchLogs[playerName] || [];
    eloHistory.forEach((h, seq) => {
      const m = log[seq] || {};
      historyRows.push({
        player_name:  playerName,
        seq,
        date:         h.date,
        fixture_id:   String(h.fixture_id),
        rubber_order: m.rubber_order ?? null,
        rating:       h.rating,
        result:       m.result       ?? null,
        partner:      m.partner      ?? null,
        opp1:         m.opp1         ?? null,
        opp2:         m.opp2         ?? null,
        team:         m.team         ?? null,
        opp_team:     m.opp_team     ?? null,
        my_games:     m.my_games     ?? null,
        opp_games:    m.opp_games    ?? null,
        division:     m.division     ?? null,
        season:       m.season       ?? null,
      });
    });
  }

  // ---- Build player_stats rows ----
  const statsRows = Object.entries(playerStats).map(([playerName, s]) => ({
    player_name:  playerName,
    best_partner: s.bestPartner,
    nemesis:      s.nemesis,
    nemesis_pair: s.nemesisPair,
    nemesis_club: s.nemesisClub,
  }));

  console.log(`\nData ready:`);
  console.log(`  players:       ${playerRows.length} rows`);
  console.log(`  match_history: ${historyRows.length} rows`);
  console.log(`  player_stats:  ${statsRows.length} rows`);

  console.log('\nClearing existing data...');
  await clearTable('york_match_history', 'player_name');
  await clearTable('york_player_stats',  'player_name');
  await clearTable('york_players',       'name');

  console.log('\nInserting...');
  await batchInsert('york_players',       playerRows,  'york_players');
  await batchInsert('york_match_history', historyRows, 'york_match_history');
  await batchInsert('york_player_stats',  statsRows,   'york_player_stats');

  console.log('\nDone! Migration complete.');
}

run().catch(err => { console.error('\nFailed:', err.message); process.exit(1); });
