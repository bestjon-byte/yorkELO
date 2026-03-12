const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
require('dotenv').config({ path: '.env.local' });
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const ALIASES_FILE = 'player-aliases.json';
const RATINGS_FILE = 'ratings_all.json';
const ALL_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];

// ---------------------------------------------------------------------------
// Helpers
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
  if (Object.keys(aliases).length === 0) return fixtures;
  const resolve = name => name ? resolveAlias(name, aliases) : name;
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

// ---------------------------------------------------------------------------
// Boot: build enriched leaderboard with first + most-recent division
// ---------------------------------------------------------------------------
function buildDivisionMaps(aliases) {
  const firstDiv = {}, lastDiv = {}, lastClub = {}, lastYear = {};
  for (const year of ALL_SEASONS) {
    const file = `fixtures_${year}.json`;
    if (!fs.existsSync(file)) continue;
    const fixtures = JSON.parse(fs.readFileSync(file)).fixtures;
    for (const f of fixtures) {
      const homeClub = teamToClub(f.home_team);
      const awayClub = teamToClub(f.away_team);
      for (const r of f.rubbers) {
        const players = [
          [r.home_player1, f.home_team, homeClub],
          [r.home_player2, f.home_team, homeClub],
          [r.away_player1, f.away_team, awayClub],
          [r.away_player2, f.away_team, awayClub],
        ];
        for (const [n, , club] of players) {
          if (!n) continue;
          const canon = resolveAlias(n, aliases);
          if (!(canon in firstDiv)) firstDiv[canon] = f.division;
          if (!(canon in lastYear) || year > lastYear[canon]) {
            lastYear[canon] = year;
            lastDiv[canon] = f.division;
            lastClub[canon] = club;
          }
        }
      }
    }
  }
  return { firstDiv, lastDiv, lastClub };
}

// ---------------------------------------------------------------------------
// Build full match logs per player (one entry per rubber played)
// Must follow the same ordering as elo.js: chronological fixtures,
// rubber_order within each fixture. Produces aligned entries with history[].
// ---------------------------------------------------------------------------
function buildPlayerMatchLogs(aliases) {
  let allFixtures = [];
  for (const year of ALL_SEASONS) {
    const file = `fixtures_${year}.json`;
    if (!fs.existsSync(file)) continue;
    allFixtures.push(...JSON.parse(fs.readFileSync(file)).fixtures);
  }
  allFixtures = applyAliases(allFixtures, aliases);
  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));

  const logs = {};

  for (const fixture of allFixtures) {
    const rubbersSorted = [...fixture.rubbers].sort((a, b) => a.rubber_order - b.rubber_order);

    for (const r of rubbersSorted) {
      if (!r.home_player1 || !r.home_player2 || !r.away_player1 || !r.away_player2) continue;
      if (r.winner === null) continue;

      const homeResult = r.winner === 'home' ? 'W' : r.winner === 'away' ? 'L' : 'D';
      const awayResult = r.winner === 'away' ? 'W' : r.winner === 'home' ? 'L' : 'D';

      const base = {
        date: fixture.date,
        fixture_id: fixture.fixture_id,
        rubber_order: r.rubber_order,
        division: fixture.division,
        season: fixture.season,
      };

      for (const [player, partner] of [[r.home_player1, r.home_player2], [r.home_player2, r.home_player1]]) {
        if (!logs[player]) logs[player] = [];
        logs[player].push({
          ...base,
          result: homeResult,
          partner,
          opp1: r.away_player1,
          opp2: r.away_player2,
          team: fixture.home_team,
          opp_team: fixture.away_team,
          my_games: r.home_games,
          opp_games: r.away_games,
        });
      }

      for (const [player, partner] of [[r.away_player1, r.away_player2], [r.away_player2, r.away_player1]]) {
        if (!logs[player]) logs[player] = [];
        logs[player].push({
          ...base,
          result: awayResult,
          partner,
          opp1: r.home_player1,
          opp2: r.home_player2,
          team: fixture.away_team,
          opp_team: fixture.home_team,
          my_games: r.away_games,
          opp_games: r.home_games,
        });
      }
    }
  }

  return logs;
}

// ---------------------------------------------------------------------------
// Compute per-player stats: best partner, nemesis player/pair/club
// ---------------------------------------------------------------------------
function buildPlayerStats(matchLogs) {
  const stats = {};

  for (const [name, log] of Object.entries(matchLogs)) {
    // Partner win rates
    const partnerMap = {};
    for (const e of log) {
      if (!partnerMap[e.partner]) partnerMap[e.partner] = { W: 0, L: 0, D: 0 };
      partnerMap[e.partner][e.result]++;
    }
    let bestPartner = null, bestPWR = -1;
    let worstPartner = null, worstPWR = 2;
    for (const [partner, s] of Object.entries(partnerMap)) {
      const total = s.W + s.L + s.D;
      if (total < 5) continue;
      const wr = (s.W + s.D * 0.5) / total;
      if (wr > bestPWR) {
        bestPWR = wr;
        bestPartner = { name: partner, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100) };
      }
      if (wr < worstPWR) {
        worstPWR = wr;
        worstPartner = { name: partner, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100) };
      }
    }

    // Opponent (individual) win rates — my win rate when facing each opponent
    const oppMap = {};
    for (const e of log) {
      for (const opp of [e.opp1, e.opp2]) {
        if (!oppMap[opp]) oppMap[opp] = { W: 0, L: 0, D: 0 };
        oppMap[opp][e.result]++;
      }
    }
    let nemesis = null, nemesisWR = 2;
    for (const [opp, s] of Object.entries(oppMap)) {
      const total = s.W + s.L + s.D;
      if (total < 3) continue;
      const wr = (s.W + s.D * 0.5) / total;
      if (wr < nemesisWR) {
        nemesisWR = wr;
        nemesis = { name: opp, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100) };
      }
    }

    // Pair win rates
    const pairMap = {};
    for (const e of log) {
      const sorted = [e.opp1, e.opp2].sort();
      const key = sorted.join('\0');
      if (!pairMap[key]) pairMap[key] = { W: 0, L: 0, D: 0, names: sorted };
      pairMap[key][e.result]++;
    }
    let nemesisPair = null, nemesisPairWR = 2;
    for (const [, s] of Object.entries(pairMap)) {
      const total = s.W + s.L + s.D;
      if (total < 3) continue;
      const wr = (s.W + s.D * 0.5) / total;
      if (wr < nemesisPairWR) {
        nemesisPairWR = wr;
        nemesisPair = { names: s.names, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100) };
      }
    }

    // Club win rates
    const clubMap = {};
    for (const e of log) {
      const club = teamToClub(e.opp_team);
      if (!clubMap[club]) clubMap[club] = { W: 0, L: 0, D: 0 };
      clubMap[club][e.result]++;
    }
    let nemesisClub = null, nemesisClubWR = 2;
    let bestClub = null, bestClubWR = -1;
    for (const [club, s] of Object.entries(clubMap)) {
      const total = s.W + s.L + s.D;
      if (total < 5) continue;
      const wr = (s.W + s.D * 0.5) / total;
      if (wr < nemesisClubWR) {
        nemesisClubWR = wr;
        nemesisClub = { name: club, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100) };
      }
      if (wr > bestClubWR) {
        bestClubWR = wr;
        bestClub = { name: club, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100) };
      }
    }

    stats[name] = { bestPartner, worstPartner, nemesis, nemesisPair, nemesisClub, bestClub };
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Load data at boot
// ---------------------------------------------------------------------------
console.log('Loading data...');
const aliases = fs.existsSync(ALIASES_FILE) ? JSON.parse(fs.readFileSync(ALIASES_FILE)) : {};
const ratingsData = JSON.parse(fs.readFileSync(RATINGS_FILE));
const { firstDiv, lastDiv, lastClub } = buildDivisionMaps(aliases);

const playerMatchLogs = buildPlayerMatchLogs(aliases);
const playerStats = buildPlayerStats(playerMatchLogs);

// Lean leaderboard (no history — loaded on demand)
const leaderboard = ratingsData.leaderboard.map((p, i) => ({
  rank: i + 1,
  name: p.name,
  rating: p.rating,
  rubbers_played: p.rubbers_played,
  last_played: p.last_played,
  first_div: firstDiv[p.name] || null,
  current_div: lastDiv[p.name] || null,
  club: lastClub[p.name] || null,
}));

const clubs = [...new Set(leaderboard.map(p => p.club).filter(Boolean))].sort();
const history = ratingsData.history;
console.log(`Ready — ${leaderboard.length} players. Open http://localhost:${PORT}`);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/api/leaderboard') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leaderboard, seasons: ratingsData.seasons, clubs }));
    return;
  }

  if (pathname.startsWith('/api/player/')) {
    const name = decodeURIComponent(pathname.slice('/api/player/'.length));
    const playerHistory = history[name];
    if (!playerHistory) { res.writeHead(404); res.end('{}'); return; }

    // Zip ELO history (has rating) with match log (has match details).
    // They align 1:1: same chronological + rubber_order processing, same skip conditions.
    const matchLog = playerMatchLogs[name] || [];
    const enrichedHistory = playerHistory.map((h, i) => ({
      rating: h.rating,
      ...matchLog[i],
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      stats: playerStats[name] || {},
      history: enrichedHistory,
    }));
    return;
  }

  if (pathname === '/api/team-ratings') {
    // Supabase-backed: same logic as api/team-ratings.js so local dev uses live data
    const teamRatingsHandler = require('./api/team-ratings');
    return teamRatingsHandler(req, res);
  }

  // Static files from public/ — directory paths serve index.html (mirrors Vercel behaviour)
  let filePath = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(filePath)) filePath = filePath.replace(/\/?$/, '/index.html');
  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(fullPath);
  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT);
