const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
require('dotenv').config({ path: '.env.local' });

const PORT = process.env.PORT || 3000;

const MENS_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];
const MIXED_SEASONS = [2023, 2024, 2025, 2026];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resolveAlias(name, aliases) {
  let r = name; const seen = new Set();
  while (aliases[r] && !seen.has(r)) { seen.add(r); r = aliases[r]; }
  return r;
}

function teamToClub(team) {
  if (!team) return '';
  return team.replace(/\s+\d+$/, '').trim();
}

function applyAliases(fixtures, aliases) {
  if (Object.keys(aliases).length === 0) return fixtures;
  const resolve = name => name ? resolveAlias(name, aliases) : name;
  return fixtures.map(f => ({
    ...f,
    rubbers: (f.rubbers || []).map(r => ({
      ...r,
      home_player1: resolve(r.home_player1),
      home_player2: resolve(r.home_player2),
      away_player1: resolve(r.away_player1),
      away_player2: resolve(r.away_player2),
    })),
  }));
}

// ---------------------------------------------------------------------------
// Data Loading Logic
// ---------------------------------------------------------------------------
function loadLeagueData(isMixed) {
  const leaguePrefix = isMixed ? 'mixed_' : '';
  const seasonsList = isMixed ? MIXED_SEASONS : MENS_SEASONS;
  const ratingsFile = `${leaguePrefix}ratings_all.json`;
  const aliasFile = `${leaguePrefix}player-aliases.json`;

  if (!fs.existsSync(ratingsFile)) {
    console.warn(`[Warning] Missing ${ratingsFile}. Run node elo.js ${isMixed ? '--mixed' : ''} first.`);
    return null;
  }

  const aliases = fs.existsSync(aliasFile) ? JSON.parse(fs.readFileSync(aliasFile)) : {};
  const ratingsData = JSON.parse(fs.readFileSync(ratingsFile));

  // Build division maps
  const firstDiv = {}, lastDiv = {}, lastClub = {}, lastYear = {};
  for (const year of seasonsList) {
    const file = `${leaguePrefix}fixtures_${year}.json`;
    if (!fs.existsSync(file)) continue;
    const fixtures = JSON.parse(fs.readFileSync(file)).fixtures;
    for (const f of fixtures) {
      const homeClub = teamToClub(f.home_team);
      const awayClub = teamToClub(f.away_team);
      for (const r of (f.rubbers || [])) {
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

  // Build match logs
  let allFixtures = [];
  for (const year of seasonsList) {
    const file = `${leaguePrefix}fixtures_${year}.json`;
    if (!fs.existsSync(file)) continue;
    allFixtures.push(...JSON.parse(fs.readFileSync(file)).fixtures);
  }
  allFixtures = applyAliases(allFixtures, aliases);
  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));

  const logs = {};
  for (const fixture of allFixtures) {
    if (!fixture.rubbers) continue;
    const rubbersSorted = [...fixture.rubbers].sort((a, b) => a.rubber_order - b.rubber_order);
    for (const r of rubbersSorted) {
      if (!r.home_player1 || !r.home_player2 || !r.away_player1 || !r.away_player2) continue;
      
      let homeResult = null, awayResult = null;
      if (r.winner === 'home') { homeResult = 'W'; awayResult = 'L'; }
      else if (r.winner === 'away') { homeResult = 'L'; awayResult = 'W'; }
      else if (r.winner === 'draw') { homeResult = 'D'; awayResult = 'D'; }
      else {
        const hg = parseInt(r.home_games), ag = parseInt(r.away_games);
        if (!isNaN(hg) && !isNaN(ag)) {
          if (hg > ag) { homeResult = 'W'; awayResult = 'L'; }
          else if (ag > hg) { homeResult = 'L'; awayResult = 'W'; }
          else { homeResult = 'D'; awayResult = 'D'; }
        }
      }
      if (!homeResult) continue;

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

  // Build stats
  const stats = {};
  for (const [name, log] of Object.entries(logs)) {
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
          best = { name: k, wins: s.W, losses: s.L, draws: s.D, total, winRate: Math.round(wr * 100), ...(s.names ? { names: s.names } : { name: k }) };
        }
      }
      return best;
    };
    stats[name] = {
      bestPartner:  pick(partnerMap, 5, true),
      worstPartner: pick(partnerMap, 5, false),
      nemesis:      pick(oppMap, 3, false),
      nemesisPair:  pick(pairMap, 3, false),
      nemesisClub:  pick(clubMap, 5, false),
      bestClub:     pick(clubMap, 5, true),
    };
  }

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

  return { leaderboard, history: ratingsData.history, playerMatchLogs: logs, playerStats: stats, clubs, seasons: seasonsList };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
console.log('Loading Men\'s data...');
const mensData = loadLeagueData(false);
console.log('Loading Mixed data...');
const mixedData = loadLeagueData(true);

console.log(`Ready. Open http://localhost:${PORT}`);

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const isMixed = parsed.query.league === 'mixed';
  const data = isMixed ? mixedData : mensData;

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/api/leaderboard') {
    if (!data) { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ leaderboard: data.leaderboard, seasons: data.seasons, clubs: data.clubs }));
    return;
  }

  if (pathname.startsWith('/api/player/')) {
    if (!data) { res.writeHead(404); res.end('{}'); return; }
    const name = decodeURIComponent(pathname.slice('/api/player/'.length));
    const playerHistory = data.history[name];
    if (!playerHistory) { res.writeHead(404); res.end('{}'); return; }

    const matchLog = data.playerMatchLogs[name] || [];
    const enrichedHistory = playerHistory.map((h, i) => ({
      rating: h.rating,
      ...matchLog[i],
    }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      stats: data.playerStats[name] || {},
      history: enrichedHistory,
    }));
    return;
  }

  if (pathname === '/api/team-ratings') {
    const teamRatingsHandler = require('./api/team-ratings');
    return teamRatingsHandler(req, res);
  }

  if (pathname === '/api/mcp') {
    const mcpHandler = require('./api/mcp');
    return mcpHandler(req, res);
  }

  let filePath = pathname === '/' ? '/index.html' : pathname;
  if (!path.extname(filePath)) filePath = filePath.replace(/\/?$/, '/index.html');
  const fullPath = path.join(__dirname, 'public', filePath);
  const ext = path.extname(fullPath);
  fs.readFile(fullPath, (err, fileData) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(fileData);
  });
});

server.listen(PORT);
