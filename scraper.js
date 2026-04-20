const cheerio = require('cheerio');
const fs = require('fs');

const BASE_URL = 'https://www.yorkmenstennisleague.co.uk';
const SEASON = 2026;
const DIVISIONS = 8;
const DELAY_MS = 1000; // Increased to 1s to be polite
const USER_AGENT = 'York-ELO-Tracker-Bot (Automated ELO Rating System; contact: your-email@example.com)';

const OUT_PATH = `fixtures_${SEASON}.json`;

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Collect all fixture URLs for a given division from its standings/fixtures page
async function getFixtureIdsForDivision(division) {
  const url = `${BASE_URL}/divisions/${division}/Division_${division}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const ids = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const match = href && href.match(/\/fixtures\/(\d+)$/);
    if (match) ids.add(parseInt(match[1], 10));
  });

  return [...ids];
}

// Parse a single fixture page into structured data
function parseFixture(html, fixtureId, division) {
  const $ = cheerio.load(html);

  // Date
  const dateText = $('main p').first().text().trim(); // e.g. "27 April 2025 - 10:00"
  const date = dateText.split(' - ')[0].trim();

  // Detect conceded fixtures — no tennis was played, no ELO impact
  const mainText = $('main').text();
  if (mainText.includes('Match conceded by')) return { skipped: true, reason: 'conceded', date };

  // The scorecard table
  const table = $('main table').first();
  if (!table.length) return { date, rubbers: [] }; // fixture not yet played / no scorecard

  // Away team name from thead (colspan=3 th)
  const awayTeam = $('thead th').filter((_, el) => $(el).attr('colspan') === '3').text().trim();
  if (!awayTeam) return { date, rubbers: [] }; // incomplete scorecard

  // tbody rows
  const rows = table.find('tbody tr').toArray();
  if (rows.length < 5) return { date, rubbers: [] }; // need sub-header + 3 data rows + summary

  // Sub-header row: home team name + away pair names
  const subHeaderCells = $(rows[0]).find('td').toArray();
  const homeTeam = $(subHeaderCells[0]).text().trim();
  const awayPairs = [1, 2, 3].map(i => {
    const cell = $(subHeaderCells[i]);
    const players = cell.html().split('<br>').map(p => cheerio.load(p).text().trim()).filter(Boolean);
    return { player1: players[0] || '', player2: players[1] || '' };
  });

  // Data rows 1-3: home pair name + 3 scores
  const rubbers = [];
  for (let rowIdx = 1; rowIdx <= 3; rowIdx++) {
    const cells = $(rows[rowIdx]).find('td').toArray();
    const pairCell = $(cells[0]);
    const homePlayers = pairCell.html().split('<br>').map(p => cheerio.load(p).text().trim()).filter(Boolean);
    const homePair = { player1: homePlayers[0] || '', player2: homePlayers[1] || '' };

    for (let colIdx = 0; colIdx < 3; colIdx++) {
      const scoreText = $(cells[colIdx + 1]).text().trim(); // e.g. "4 - 8"
      const scoreParts = scoreText.split('-').map(s => parseInt(s.trim(), 10));
      const homeGames = scoreParts[0];
      const awayGames = scoreParts[1];

      let winner;
      if (isNaN(homeGames) || isNaN(awayGames)) {
        winner = null; // unparseable
      } else if (homeGames > awayGames) {
        winner = 'home';
      } else if (awayGames > homeGames) {
        winner = 'away';
      } else {
        winner = 'draw';
      }

      rubbers.push({
        rubber_order: (rowIdx - 1) * 3 + (colIdx + 1), // 1-9
        home_player1: homePair.player1,
        home_player2: homePair.player2,
        away_player1: awayPairs[colIdx].player1,
        away_player2: awayPairs[colIdx].player2,
        home_games: homeGames,
        away_games: awayGames,
        winner, // 'home' | 'away' | 'draw' | null
      });
    }
  }

  return {
    fixture_id: fixtureId,
    season: SEASON,
    division,
    date,
    home_team: homeTeam,
    away_team: awayTeam,
    source_url: `${BASE_URL}/fixtures/${fixtureId}`,
    rubbers,
  };
}

async function main() {
  console.log(`Scraping York Mens Tennis League — Season ${SEASON} (TEMP: Division 8 only)`);

  // Load existing data
  let existingData = { fixtures: [] };
  if (fs.existsSync(OUT_PATH)) {
    try {
      existingData = JSON.parse(fs.readFileSync(OUT_PATH));
    } catch (e) {}
  }

  // Preserve all fixtures NOT in division 8
  const allFixtures = existingData.fixtures.filter(f => f.division !== 8);
  const existingMap = new Map(existingData.fixtures.map(f => [f.fixture_id, f]));

  // Step 1: collect only Division 8 fixture IDs
  const div = 8;
  process.stdout.write(`Division ${div}: collecting fixture IDs...`);
  const ids = await getFixtureIdsForDivision(div);
  console.log(` ${ids.length} fixtures found`);
  await sleep(DELAY_MS);

  // Step 2: scrape each fixture for Division 8
  const errors = [];
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  console.log(`\nDivision ${div}: checking ${ids.length} fixtures`);

  for (const id of ids) {
    const existing = existingMap.get(id);
    
    if (existing && existing.rubbers && existing.rubbers.length > 0) {
      allFixtures.push(existing);
      continue;
    }

    if (existing && existing.date) {
      const cachedDate = new Date(existing.date);
      if (cachedDate > today) {
        process.stdout.write(`  Fixture ${id}... skipped (future: ${existing.date})\n`);
        allFixtures.push(existing);
        continue;
      }
    }

    process.stdout.write(`  Fixture ${id}...`);
    
    const url = `${BASE_URL}/fixtures/${id}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.log(` failed: ${err.message}`);
      if (existing) allFixtures.push(existing);
      errors.push(id);
      continue;
    }

    const fixture = parseFixture(html, id, div);

    if (fixture && fixture.date) {
      const fixtureDate = new Date(fixture.date);
      if (fixtureDate > today) {
        console.log(` skipped (future: ${fixture.date})`);
        allFixtures.push({ fixture_id: id, date: fixture.date, division: div, rubbers: [] });
        continue;
      }
    }

    if (fixture && fixture.skipped) {
      console.log(` skipped (${fixture.reason})`);
      allFixtures.push(fixture);
    } else if (fixture && fixture.rubbers && fixture.rubbers.length > 0) {
      allFixtures.push(fixture);
      console.log(` ${fixture.home_team} v ${fixture.away_team} (${fixture.rubbers.length} rubbers)`);
    } else {
      console.log(' skipped (no scorecard yet)');
      allFixtures.push({ fixture_id: id, date: fixture ? fixture.date : (existing ? existing.date : null), division: div, rubbers: [] });
      errors.push(id);
    }
    
    await sleep(DELAY_MS);
  }

  // Step 3: sort by date, then write output
  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));

  const output = {
    scraped_at: new Date().toISOString(),
    season: SEASON,
    fixture_count: allFixtures.filter(f => f.rubbers && f.rubbers.length > 0).length,
    rubber_count: allFixtures.reduce((n, f) => n + (f.rubbers ? f.rubbers.length : 0), 0),
    skipped_fixture_ids: errors,
    fixtures: allFixtures,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nDone. ${output.fixture_count} fixtures with results (including other divisions) → ${OUT_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
