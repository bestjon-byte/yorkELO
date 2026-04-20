const cheerio = require('cheerio');
const fs = require('fs');

const BASE_URL = 'https://www.yorkmenstennisleague.co.uk';
const SEASON = 2026;
const DIVISIONS = 8;
const DELAY_MS = 1000;
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

/**
 * Scrapes the division page to get ALL fixtures and their dates in one go.
 * This prevents having to hit individual fixture pages just to find out when they are.
 */
async function getFixturesFromDivisionPage(division) {
  const url = `${BASE_URL}/divisions/${division}/Division_${division}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const fixtures = [];
  // The fixtures are usually in a table; we look for the links
  $('tr').each((_, tr) => {
    const row = $(tr);
    const link = row.find('a[href*="/fixtures/"]');
    if (link.length) {
      const href = link.attr('href');
      const id = parseInt(href.match(/\/fixtures\/(\d+)$/)[1], 10);
      
      // Try to find the date in the same row
      // Usually the date is in one of the cells (e.g. "27 April 2026")
      let date = null;
      row.find('td').each((_, td) => {
        const text = $(td).text().trim();
        if (text.match(/\d+\s+\w+\s+\d{4}/)) {
          date = text;
        }
      });
      
      if (id) {
        fixtures.push({ id, date });
      }
    }
  });

  return fixtures;
}

// Parse a single fixture page into structured data (scorecard details)
function parseFixture(html, fixtureId, division) {
  const $ = cheerio.load(html);

  // Date (as a fallback/confirmation)
  const dateText = $('main p').first().text().trim();
  const date = dateText.split(' - ')[0].trim();

  // Detect conceded fixtures
  const mainText = $('main').text();
  if (mainText.includes('Match conceded by')) return { skipped: true, reason: 'conceded', date };

  // The scorecard table
  const table = $('main table').first();
  if (!table.length) return { date, rubbers: [] };

  const awayTeam = $('thead th').filter((_, el) => $(el).attr('colspan') === '3').text().trim();
  if (!awayTeam) return { date, rubbers: [] };

  const rows = table.find('tbody tr').toArray();
  if (rows.length < 5) return { date, rubbers: [] };

  const subHeaderCells = $(rows[0]).find('td').toArray();
  const homeTeam = $(subHeaderCells[0]).text().trim();
  const awayPairs = [1, 2, 3].map(i => {
    const cell = $(subHeaderCells[i]);
    const players = cell.html().split('<br>').map(p => cheerio.load(p).text().trim()).filter(Boolean);
    return { player1: players[0] || '', player2: players[1] || '' };
  });

  const rubbers = [];
  for (let rowIdx = 1; rowIdx <= 3; rowIdx++) {
    const cells = $(rows[rowIdx]).find('td').toArray();
    const pairCell = $(cells[0]);
    const homePlayers = pairCell.html().split('<br>').map(p => cheerio.load(p).text().trim()).filter(Boolean);
    const homePair = { player1: homePlayers[0] || '', player2: homePlayers[1] || '' };

    for (let colIdx = 0; colIdx < 3; colIdx++) {
      const scoreText = $(cells[colIdx + 1]).text().trim();
      const scoreParts = scoreText.split('-').map(s => parseInt(s.trim(), 10));
      const homeGames = scoreParts[0];
      const awayGames = scoreParts[1];

      let winner = null;
      if (!isNaN(homeGames) && !isNaN(awayGames)) {
        if (homeGames > awayGames) winner = 'home';
        else if (awayGames > homeGames) winner = 'away';
        else winner = 'draw';
      }

      rubbers.push({
        rubber_order: (rowIdx - 1) * 3 + (colIdx + 1),
        home_player1: homePair.player1,
        home_player2: homePair.player2,
        away_player1: awayPairs[colIdx].player1,
        away_player2: awayPairs[colIdx].player2,
        home_games: homeGames,
        away_games: awayGames,
        winner,
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
  console.log(`Scraping York Mens Tennis League — Season ${SEASON}`);

  let existingData = { fixtures: [] };
  if (fs.existsSync(OUT_PATH)) {
    try {
      existingData = JSON.parse(fs.readFileSync(OUT_PATH));
      console.log(`Loaded ${existingData.fixtures.length} existing fixtures.`);
    } catch (e) {}
  }

  const existingMap = new Map(existingData.fixtures.map(f => [f.fixture_id, f]));
  const allFixtures = [];
  const errors = [];
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  for (let div = 1; div <= DIVISIONS; div++) {
    process.stdout.write(`Division ${div}: fetching season schedule...`);
    const divisionFixtures = await getFixturesFromDivisionPage(div);
    console.log(` ${divisionFixtures.length} matches found`);
    
    // Process each match in the division
    for (const item of divisionFixtures) {
      const id = item.id;
      const existing = existingMap.get(id);

      // 1. If we already have a scorecard, we are done.
      if (existing && existing.rubbers && existing.rubbers.length > 0) {
        allFixtures.push(existing);
        continue;
      }

      // 2. Determine the date (either from the division page or our cache)
      const dateStr = item.date || (existing ? existing.date : null);
      
      // 3. If it's in the future, we record the date and skip the network hit.
      if (dateStr) {
        const matchDate = new Date(dateStr);
        if (matchDate > today) {
          allFixtures.push({ fixture_id: id, date: dateStr, division: div, rubbers: [] });
          continue;
        }
      }

      // 4. If we get here, the match is in the past/today and we don't have a scorecard.
      // TIME TO HIT THE NETWORK.
      process.stdout.write(`  Fixture ${id}...`);
      const url = `${BASE_URL}/fixtures/${id}`;
      try {
        const html = await fetchHtml(url);
        const fixture = parseFixture(html, id, div);

        if (fixture && fixture.skipped) {
          console.log(` skipped (${fixture.reason})`);
          allFixtures.push(fixture);
        } else if (fixture && fixture.rubbers && fixture.rubbers.length > 0) {
          allFixtures.push(fixture);
          console.log(` ${fixture.home_team} v ${fixture.away_team} (${fixture.rubbers.length} rubbers)`);
        } else {
          console.log(' no scorecard yet');
          allFixtures.push({ fixture_id: id, date: fixture ? fixture.date : dateStr, division: div, rubbers: [] });
          errors.push(id);
        }
      } catch (err) {
        console.log(` failed: ${err.message}`);
        if (existing) allFixtures.push(existing);
        errors.push(id);
      }
      
      await sleep(DELAY_MS);
    }
    
    await sleep(DELAY_MS); // Extra delay between divisions
  }

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
  console.log(`\nDone. ${output.fixture_count} fixtures with results saved to ${OUT_PATH}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
