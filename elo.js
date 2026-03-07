const fs = require('fs');

const K_FACTOR = 32;
const RATING_FLOOR = 500;
const RATING_CEILING = 3000;

// Seed rating by division — calibrated to actual inter-division rating gaps
const DIVISION_SEEDS = { 1: 1600, 2: 1470, 3: 1350, 4: 1230, 5: 1110, 6: 1040, 7: 970, 8: 900 };
function seedRating(division) {
  return DIVISION_SEEDS[division] ?? 1200;
}
const ALIASES_FILE = 'player-aliases.json';
const ALL_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];

function expectedScore(playerRating, opponentRating) {
  return 1 / (1 + Math.pow(10, (opponentRating - playerRating) / 400));
}

function clamp(rating) {
  return Math.max(RATING_FLOOR, Math.min(RATING_CEILING, rating));
}

function calcChange(playerRating, opponentRating, actualScore) {
  return K_FACTOR * (actualScore - expectedScore(playerRating, opponentRating));
}

function loadAliases() {
  if (!fs.existsSync(ALIASES_FILE)) return {};
  return JSON.parse(fs.readFileSync(ALIASES_FILE));
}

// Follow alias chain in case of chained aliases (A→B→C)
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

  // Sort all fixtures chronologically across all seasons
  const sorted = [...fixtures].sort((a, b) => new Date(a.date) - new Date(b.date));

  for (const fixture of sorted) {
    const rubbersSorted = [...fixture.rubbers].sort((a, b) => a.rubber_order - b.rubber_order);

    for (const r of rubbersSorted) {
      if (!r.home_player1 || !r.home_player2 || !r.away_player1 || !r.away_player2) continue;
      if (r.winner === null) continue; // unparseable score — skip

      const div = fixture.division;
      const homeRating = (getRating(r.home_player1, div) + getRating(r.home_player2, div)) / 2;
      const awayRating = (getRating(r.away_player1, div) + getRating(r.away_player2, div)) / 2;

      let homeActual, awayActual;
      if (r.winner === 'home') {
        homeActual = 1; awayActual = 0;
      } else if (r.winner === 'away') {
        homeActual = 0; awayActual = 1;
      } else {
        homeActual = 0.5; awayActual = 0.5; // draw
      }

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
  const singleFile = args.find(a => a.endsWith('.json'));

  let fixtures, seasons;

  if (singleFile) {
    // Single-file mode: node elo.js fixtures_2025.json
    if (!fs.existsSync(singleFile)) {
      console.error(`File not found: ${singleFile}`);
      process.exit(1);
    }
    const data = JSON.parse(fs.readFileSync(singleFile));
    fixtures = data.fixtures;
    seasons = [data.season];
    console.log(`Processing ${data.fixture_count} fixtures, ${data.rubber_count} rubbers from ${singleFile}...`);
  } else {
    // All-seasons mode (default): loads all available season files
    seasons = [];
    fixtures = [];
    console.log('Loading all seasons...');
    for (const year of ALL_SEASONS) {
      const file = `fixtures_${year}.json`;
      if (!fs.existsSync(file)) {
        console.log(`  ${file}: not found, skipping`);
        continue;
      }
      const data = JSON.parse(fs.readFileSync(file));
      fixtures.push(...data.fixtures);
      seasons.push(year);
      console.log(`  ${file}: ${data.fixture_count} fixtures, ${data.rubber_count} rubbers`);
    }
    const rubberTotal = fixtures.reduce((n, f) => n + f.rubbers.length, 0);
    console.log(`Total: ${fixtures.length} fixtures, ${rubberTotal} rubbers across ${seasons.length} seasons`);
  }

  // Apply player aliases before ELO processing
  const aliases = loadAliases();
  const aliasCount = Object.keys(aliases).length;
  if (aliasCount > 0) {
    console.log(`Applying ${aliasCount} player aliases...`);
    fixtures = applyAliases(fixtures, aliases);
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

  const outFile = `ratings_${label}.json`;
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('\nTop 20 players:');
  leaderboard.slice(0, 20).forEach((p, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(30)} ${p.rating.toFixed(1).padStart(7)}  (${p.rubbers_played} rubbers)`);
  });
  console.log(`\n${leaderboard.length} players rated → ${outFile}`);
}

run();
