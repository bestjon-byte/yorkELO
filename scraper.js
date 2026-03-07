const cheerio = require('cheerio');
const fs = require('fs');

const BASE_URL = 'https://www.yorkmenstennisleague.co.uk';
const SEASON = 2025;
const DIVISIONS = 8;
const DELAY_MS = 500; // polite delay between requests

async function fetchHtml(url) {
  const res = await fetch(url);
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
  if (mainText.includes('Match conceded by')) return { skipped: true, reason: 'conceded' };

  // The scorecard table
  const table = $('main table').first();
  if (!table.length) return null; // fixture not yet played / no scorecard

  // Away team name from thead (colspan=3 th)
  const awayTeam = $('thead th').filter((_, el) => $(el).attr('colspan') === '3').text().trim();
  if (!awayTeam) return null; // incomplete scorecard

  // tbody rows
  const rows = table.find('tbody tr').toArray();
  if (rows.length < 5) return null; // need sub-header + 3 data rows + summary

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

async function scrapeFixture(fixtureId, division) {
  const url = `${BASE_URL}/fixtures/${fixtureId}`;
  try {
    const html = await fetchHtml(url);
    return parseFixture(html, fixtureId, division);
  } catch (err) {
    console.warn(`  Failed fixture ${fixtureId}: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log(`Scraping York Mens Tennis League — Season ${SEASON}`);

  // Step 1: collect all fixture IDs from all division pages
  const fixturesByDivision = {};
  for (let div = 1; div <= DIVISIONS; div++) {
    process.stdout.write(`Division ${div}: collecting fixture IDs...`);
    const ids = await getFixtureIdsForDivision(div);
    fixturesByDivision[div] = ids;
    console.log(` ${ids.length} fixtures found`);
    await sleep(DELAY_MS);
  }

  // Step 2: scrape each fixture
  const allFixtures = [];
  const errors = [];

  for (let div = 1; div <= DIVISIONS; div++) {
    const ids = fixturesByDivision[div];
    console.log(`\nDivision ${div}: scraping ${ids.length} fixtures`);

    for (const id of ids) {
      process.stdout.write(`  Fixture ${id}...`);
      const fixture = await scrapeFixture(id, div);
      if (fixture && fixture.skipped) {
        console.log(` skipped (${fixture.reason})`);
      } else if (fixture) {
        allFixtures.push(fixture);
        console.log(` ${fixture.home_team} v ${fixture.away_team} (${fixture.rubbers.length} rubbers)`);
      } else {
        console.log(' skipped (no scorecard)');
        errors.push(id);
      }
      await sleep(DELAY_MS);
    }
  }

  // Step 3: sort by date, then write output
  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));

  const output = {
    scraped_at: new Date().toISOString(),
    season: SEASON,
    fixture_count: allFixtures.length,
    rubber_count: allFixtures.reduce((n, f) => n + f.rubbers.length, 0),
    skipped_fixture_ids: errors,
    fixtures: allFixtures,
  };

  const outPath = `fixtures_${SEASON}.json`;
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\nDone. ${allFixtures.length} fixtures, ${output.rubber_count} rubbers → ${outPath}`);
  if (errors.length) console.log(`Skipped ${errors.length} fixture IDs (not yet played or parse error)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
