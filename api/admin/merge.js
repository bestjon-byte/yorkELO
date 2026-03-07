/**
 * POST /api/admin/merge
 * Body: { passcode, from: "Player A name", into: "Player B name" }
 *
 * 1. Validates passcode against ADMIN_PASSCODE env var
 * 2. Saves alias to york_aliases table
 * 3. Re-runs full ELO computation using fixture files + all aliases
 * 4. Upserts york_players and york_player_stats
 * 5. Fixes player names in york_match_history (ELO values update on next local migration)
 */

const { createClient } = require('@supabase/supabase-js');
const fs   = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // needs write access
);

const ALL_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];
const K_FACTOR = 32, FLOOR = 500, CEILING = 3000;
const DIVISION_SEEDS = { 1:1600, 2:1470, 3:1350, 4:1230, 5:1110, 6:1040, 7:970, 8:900 };
const CHUNK = 500;

// ---------------------------------------------------------------------------
// ELO helpers
// ---------------------------------------------------------------------------
function resolveAlias(name, aliases) {
  let r = name; const seen = new Set();
  while (aliases[r] && !seen.has(r)) { seen.add(r); r = aliases[r]; }
  return r;
}
function teamToClub(t) { return t.replace(/\s+\d+$/, '').trim(); }
function expected(a, b) { return 1 / (1 + Math.pow(10, (b - a) / 400)); }
function clamp(r) { return Math.max(FLOOR, Math.min(CEILING, r)); }

function applyAliases(fixtures, aliases) {
  const resolve = n => n ? resolveAlias(n, aliases) : n;
  return fixtures.map(f => ({
    ...f, rubbers: f.rubbers.map(r => ({
      ...r,
      home_player1: resolve(r.home_player1), home_player2: resolve(r.home_player2),
      away_player1: resolve(r.away_player1), away_player2: resolve(r.away_player2),
    }))
  }));
}

function runElo(fixtures) {
  const ratings = {}, history = {};
  const getRating = (name, div) => { if (!(name in ratings)) ratings[name] = DIVISION_SEEDS[div] ?? 1200; return ratings[name]; };

  const sorted = [...fixtures].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const fixture of sorted) {
    for (const r of [...fixture.rubbers].sort((a, b) => a.rubber_order - b.rubber_order)) {
      if (!r.home_player1 || !r.home_player2 || !r.away_player1 || !r.away_player2) continue;
      if (r.winner === null) continue;
      const div = fixture.division;
      const hR = (getRating(r.home_player1, div) + getRating(r.home_player2, div)) / 2;
      const aR = (getRating(r.away_player1, div) + getRating(r.away_player2, div)) / 2;
      const hA = r.winner === 'home' ? 1 : r.winner === 'away' ? 0 : 0.5;
      const aA = 1 - hA;
      const hC = K_FACTOR * (hA - expected(hR, aR));
      const aC = K_FACTOR * (aA - expected(aR, hR));
      for (const name of [r.home_player1, r.home_player2]) {
        ratings[name] = clamp(getRating(name) + hC);
        (history[name] = history[name] || []).push({ date: fixture.date, fixture_id: String(fixture.fixture_id), rating: ratings[name] });
      }
      for (const name of [r.away_player1, r.away_player2]) {
        ratings[name] = clamp(getRating(name) + aC);
        (history[name] = history[name] || []).push({ date: fixture.date, fixture_id: String(fixture.fixture_id), rating: ratings[name] });
      }
    }
  }
  return { ratings, history };
}

function buildDivisionMaps(fixtures, aliases) {
  const firstDiv = {}, lastDiv = {}, lastClub = {}, lastYear = {};
  for (const f of fixtures) {
    const year = f.season;
    const homeClub = teamToClub(f.home_team), awayClub = teamToClub(f.away_team);
    for (const r of f.rubbers) {
      for (const [n, club] of [
        [r.home_player1, homeClub], [r.home_player2, homeClub],
        [r.away_player1, awayClub], [r.away_player2, awayClub],
      ]) {
        if (!n) continue;
        const canon = resolveAlias(n, aliases);
        if (!(canon in firstDiv)) firstDiv[canon] = f.division;
        if (!(canon in lastYear) || year > lastYear[canon]) {
          lastYear[canon] = year; lastDiv[canon] = f.division; lastClub[canon] = club;
        }
      }
    }
  }
  return { firstDiv, lastDiv, lastClub };
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
    const pick = (map, min, high) => {
      let best = null, bwr = high ? -1 : 2;
      for (const [k, s] of Object.entries(map)) {
        const total = s.W+s.L+s.D; if (total < min) continue;
        const wr = (s.W + s.D*0.5) / total;
        if (high ? wr > bwr : wr < bwr) { bwr = wr; best = { ...s, key: k, total, winRate: Math.round(wr*100), ...(s.names ? { names: s.names } : { name: k }) }; }
      }
      if (best) delete best.key;
      return best;
    };
    const bp = pick(partnerMap, 5, true);
    const nm = pick(oppMap, 3, false);
    const rp = pick(pairMap, 3, false);
    const rc = pick(clubMap, 5, false);
    stats[name] = {
      bestPartner: bp,
      nemesis: nm,
      nemesisPair: rp ? { names: rp.names, wins: rp.W, losses: rp.L, draws: rp.D, total: rp.total, winRate: rp.winRate } : null,
      nemesisClub: rc ? { name: rc.key || rc.name, wins: rc.W, losses: rc.L, draws: rc.D, total: rc.total, winRate: rc.winRate } : null,
    };
  }
  return stats;
}

function buildMatchLogs(fixtures) {
  const logs = {};
  const sorted = [...fixtures].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const fixture of sorted) {
    for (const r of [...fixture.rubbers].sort((a, b) => a.rubber_order - b.rubber_order)) {
      if (!r.home_player1 || !r.home_player2 || !r.away_player1 || !r.away_player2) continue;
      if (r.winner === null) continue;
      const hRes = r.winner === 'home' ? 'W' : r.winner === 'away' ? 'L' : 'D';
      const aRes = r.winner === 'away' ? 'W' : r.winner === 'home' ? 'L' : 'D';
      const base = { date: fixture.date, fixture_id: String(fixture.fixture_id), rubber_order: r.rubber_order, division: fixture.division, season: fixture.season };
      for (const [pl, partner] of [[r.home_player1,r.home_player2],[r.home_player2,r.home_player1]]) {
        (logs[pl] ??= []).push({ ...base, result: hRes, partner, opp1: r.away_player1, opp2: r.away_player2, team: fixture.home_team, opp_team: fixture.away_team, my_games: r.home_games, opp_games: r.away_games });
      }
      for (const [pl, partner] of [[r.away_player1,r.away_player2],[r.away_player2,r.away_player1]]) {
        (logs[pl] ??= []).push({ ...base, result: aRes, partner, opp1: r.home_player1, opp2: r.home_player2, team: fixture.away_team, opp_team: fixture.home_team, my_games: r.away_games, opp_games: r.home_games });
      }
    }
  }
  return logs;
}

async function batchUpsert(table, rows, key) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + CHUNK), { onConflict: key });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Parse request body
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') { res.statusCode = 405; res.end('{}'); return; }

  let body;
  try { body = req.body ?? await readBody(req); }
  catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

  const { passcode, from: fromName, into: intoName } = body;

  if (!passcode || passcode !== process.env.ADMIN_PASSCODE) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'Invalid passcode' }));
    return;
  }
  if (!fromName || !intoName || fromName === intoName) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'Invalid player names' }));
    return;
  }

  try {
    // 1. Save alias to york_aliases
    const { error: aliasErr } = await supabase
      .from('york_aliases')
      .upsert({ variant_name: fromName, canonical_name: intoName }, { onConflict: 'variant_name' });
    if (aliasErr) throw new Error(`york_aliases: ${aliasErr.message}`);

    // 2. Load all aliases (file-based + Supabase)
    const root = process.cwd();
    const fileAliases = fs.existsSync(path.join(root, 'player-aliases.json'))
      ? JSON.parse(fs.readFileSync(path.join(root, 'player-aliases.json')))
      : {};
    const { data: dbAliases } = await supabase.from('york_aliases').select('variant_name, canonical_name');
    const aliases = { ...fileAliases };
    for (const { variant_name, canonical_name } of dbAliases || []) aliases[variant_name] = canonical_name;

    // 3. Load and alias all fixtures
    let fixtures = [];
    for (const year of ALL_SEASONS) {
      const file = path.join(root, `fixtures_${year}.json`);
      if (fs.existsSync(file)) fixtures.push(...JSON.parse(fs.readFileSync(file)).fixtures);
    }
    fixtures = applyAliases(fixtures, aliases);

    // 4. Re-run ELO
    const { ratings, history } = runElo(fixtures);
    const { firstDiv, lastDiv, lastClub } = buildDivisionMaps(fixtures, aliases);
    const matchLogs = buildMatchLogs(fixtures);
    const playerStats = buildPlayerStats(matchLogs);

    const leaderboard = Object.entries(ratings)
      .map(([name, rating]) => ({ name, rating: Math.round(rating * 10) / 10, rubbers_played: history[name].length, last_played: history[name].at(-1).date }))
      .sort((a, b) => b.rating - a.rating);

    // 5. Upsert york_players
    const playerRows = leaderboard.map((p, i) => ({
      name: p.name, rating: p.rating, rubbers_played: p.rubbers_played, last_played: p.last_played,
      first_div: firstDiv[p.name] || null, current_div: lastDiv[p.name] || null,
      club: lastClub[p.name] || null, rank: i + 1,
    }));
    await batchUpsert('york_players', playerRows, 'name');

    // 6. Upsert york_player_stats
    const statsRows = Object.entries(playerStats).map(([playerName, s]) => ({
      player_name: playerName, best_partner: s.bestPartner, nemesis: s.nemesis,
      nemesis_pair: s.nemesisPair, nemesis_club: s.nemesisClub,
    }));
    await batchUpsert('york_player_stats', statsRows, 'player_name');

    // 7. Fix player names in york_match_history (immediate rename; ELO values update on next local migration)
    for (const col of ['player_name', 'partner', 'opp1', 'opp2']) {
      await supabase.from('york_match_history').update({ [col]: intoName }).eq(col, fromName);
    }

    // 8. Remove the merged player from york_players if they still exist as a stale row
    await supabase.from('york_players').delete().eq('name', fromName);

    res.end(JSON.stringify({ success: true, merged: `${fromName} → ${intoName}`, playerCount: leaderboard.length }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
