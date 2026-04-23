const fs = require('fs');

const K_FACTOR = 32;
const RATING_FLOOR = 500;
const RATING_CEILING = 3000;

// Seed rating by division — calibrated to actual inter-division rating gaps
const MENS_DIVISION_SEEDS = { 1: 1600, 2: 1470, 3: 1350, 4: 1230, 5: 1110, 6: 1040, 7: 970, 8: 900 };
const MIXED_DIVISION_SEEDS = { 1: 1600, 2: 1480, 3: 1360, 4: 1240, 5: 1120, 6: 1040, 7: 960, 8: 880, 9: 800, 10: 720 };

let currentDivisionSeeds = MENS_DIVISION_SEEDS;

function seedRating(division) {
  return currentDivisionSeeds[division] ?? 1200;
}

const MENS_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];
const MIXED_SEASONS = [2023, 2024, 2025, 2026];

function expectedScore(playerRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
}

function clamp(rating) {
  return Math.max(RATING_FLOOR, Math.min(RATING_CEILING, rating));
}

function calcChange(playerRating, opponentRating, actualScore) {
  return K_FACTOR * (actualScore - expectedScore(playerRating, opponentRating));
}

function loadAliases(leaguePrefix) {
  const file = `${leaguePrefix}player-aliases.json`;
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file));
}

function loadSplits(leaguePrefix) {
  const file = `${leaguePrefix}player-splits.json`;
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file));
}

// Apply player splits: rename "Paul Birch" → "Paul Birch (Knaresborough)" etc.
function applySplits(fixtures, splits) {
  if (Object.keys(splits).length === 0) return fixtures;
  const clubOf = t => t.replace(/\s+\d+$/, '').trim();
  const splitName = (name, team) => {
    const defs = splits[name];
    if (!defs) return name;
    const club = clubOf(team);
    const def = defs.find(d => d.clubs.includes(club));
    return def ? def.label : name;
  };
  return fixtures.map(f => ({
    ...f,
    rubbers: f.rubbers.map(r => ({
      ...r,
      home_player1: r.home_player1 ? splitName(r.home_player1, f.home_team) : r.home_player1,
      home_player2: r.home_player2 ? splitName(r.home_player2, f.home_team) : r.home_player2,
      away_player1: r.away_player1 ? splitName(r.away_player1, f.away_team) : r.away_player1,
      away_player2: r.away_player2 ? splitName(r.away_player2, f.away_team) : r.away_player2,
    })),
  }));
}

// Follow alias chain (A→B→C)
function resolveAlias(name, aliases) {
  let resolved = name;
  const seen = new Set();
  while (aliases[resolved] && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = aliases[resolved];
  }
  return resolved;
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

function processFixtures(fixtures) {
  const ratings = {};
  const history = {};

  function getRating(name, division) {
    if (!(name in ratings)) ratings[name] = seedRating(division);
    return ratings[name];
  }

  function recordHistory(name, rating, date, fixtureId) {
    if (!history[name]) history[name] = [];
    history[name].push({ date, fixture_id: fixtureId, rating });
  }

  const sorted = [...fixtures].sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const fixture of sorted) {
    if (!fixture.rubbers) continue;
    const rubbersSorted = [...fixture.rubbers].sort((a, b) => a.rubber_order - b.rubber_order);

    for (const r of rubbersSorted) {
      if (!r.home_player1 || !r.home_player2 || !r.away_player1 || !r.away_player2) continue;
      
      let homeActual = null, awayActual = null;
      if (r.winner === 'home') {
        homeActual = 1; awayActual = 0;
      } else if (r.winner === 'away') {
        homeActual = 0; awayActual = 1;
      } else if (r.winner === 'draw') {
        homeActual = 0.5; awayActual = 0.5;
      }

      if (homeActual === null) {
        // Fallback for MyDivision style where winner isn't always explicit in the source
        const hg = parseInt(r.home_games), ag = parseInt(r.away_games);
        if (!isNaN(hg) && !isNaN(ag)) {
          if (hg > ag) { homeActual = 1; awayActual = 0; }
          else if (ag > hg) { homeActual = 0; awayActual = 1; }
          else { homeActual = 0.5; awayActual = 0.5; }
        }
      }
      
      if (homeActual === null) continue; // skip unparseable

      const div = fixture.division;
      const homeRating = (getRating(r.home_player1, div) + getRating(r.home_player2, div)) / 2;
      const awayRating = (getRating(r.away_player1, div) + getRating(r.away_player2, div)) / 2;

      const homeChange = calcChange(homeRating, awayRating, homeActual);
      const awayChange = calcChange(awayRating, homeRating, awayActual);

      for (const name of [r.home_player1, r.home_player2]) {
        ratings[name] = clamp(getRating(name) + homeChange);
        recordHistory(name, ratings[name], fixture.date, fixture.fixture_id);
      }
      for (const name of [r.away_player1, r.away_player2]) {
        ratings[name] = clamp(getRating(name) + awayChange);
        recordHistory(name, ratings[name], fixture.date, fixture.fixture_id);
      }
    }
  }

  return { ratings, history };
}

function run() {
  const args = process.argv.slice(2);
  const isMixed = args.includes('--mixed');
  const leaguePrefix = isMixed ? 'mixed_' : '';
  const seasonsList = isMixed ? MIXED_SEASONS : MENS_SEASONS;
  currentDivisionSeeds = isMixed ? MIXED_DIVISION_SEEDS : MENS_DIVISION_SEEDS;

  console.log(`Running ELO for ${isMixed ? 'MIXED' : 'MENS'} league...`);

  const singleFile = args.find(a => a.endsWith('.json') && !a.startsWith('--'));
  let fixtures, seasons;

  if (singleFile) {
    if (!fs.existsSync(singleFile)) {
      console.error(`File not found: ${singleFile}`);
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(singleFile));
    fixtures = data.fixtures;
    seasons = [data.season];
    console.log(`Processing ${data.fixture_count} fixtures from ${singleFile}...`);
  } else {
    seasons = [];
    fixtures = [];
    for (const year of seasonsList) {
      const file = `${leaguePrefix}fixtures_${year}.json`;
      if (!fs.existsSync(file)) {
        console.log(`  ${file}: not found, skipping`);
        continue;
      }
      const data = JSON.parse(fs.readFileSync(file));
      fixtures.push(...data.fixtures);
      seasons.push(year);
      console.log(`  ${file}: ${data.fixture_count} fixtures`);
    }
  }

  const aliases = loadAliases(leaguePrefix);
  if (Object.keys(aliases).length > 0) {
    console.log(`Applying ${Object.keys(aliases).length} player aliases...`);
    fixtures = applyAliases(fixtures, aliases);
  }
  const splits = loadSplits(leaguePrefix);
  if (Object.keys(splits).length > 0) {
    console.log(`Applying ${Object.keys(splits).length} player splits...`);
    fixtures = applySplits(fixtures, splits);
  }

  const { ratings, history } = processFixtures(fixtures);

  const leaderboard = Object.entries(ratings)
    .map(([name, rating]) => ({
      name,
      rating: Math.round(rating * 10) / 10,
      rubbers_played: history[name].length,
      last_played: history[name][history[name].length - 1].date,
    }))
    .sort((a, b) => b.rating - a.rating);

  const label = seasons.length === 1 ? seasons[0] : 'all';
  const output = {
    generated_at: new Date().toISOString(),
    seasons,
    player_count: leaderboard.length,
    leaderboard,
    history,
  };

  const outFile = `${leaguePrefix}ratings_${label}.json`;
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\n${leaderboard.length} players rated → ${outFile}`);
}

run();
