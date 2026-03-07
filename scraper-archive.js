const cheerio = require('cheerio');
const fs = require('fs');

const SEASONS = [2018, 2019, 2021, 2022, 2023, 2024]; // no 2020 (COVID)
const DIVISIONS = 8;
const DELAY_MS = 750; // polite — multiple agents may run in parallel

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHtml(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function baseUrl(year) {
  return `https://www.yorkmenstennisleague.co.uk/archive/${year}`;
}

// Extract plain text from a cell that may contain <a> links
function cellText($, el) {
  return $(el).text().trim();
}

// Extract two player names from a cell with "Name1\nName2" or <a>Name1</a><br><a>Name2</a>
function extractPair($, cell) {
  const links = $(cell).find('a');
  if (links.length >= 2) {
    return { player1: $(links[0]).text().trim(), player2: $(links[1]).text().trim() };
  }
  // Fallback: split on <br>
  const html = $(cell).html() || '';
  const parts = html.split(/<br\s*\/?>/i).map(p => cheerio.load(p).text().trim()).filter(Boolean);
  return { player1: parts[0] || '', player2: parts[1] || '' };
}

async function getFixtureIdsForDivision(year, division) {
  const url = `${baseUrl(year)}/divisions.php?id=${division}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const ids = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const match = href.match(/result\.php\?id=(\d+)/);
    if (match) ids.add(match[1]); // keep as string e.g. "2024001"
  });
  return [...ids];
}

function parseArchiveFixture(html, fixtureId, division, year) {
  const $ = cheerio.load(html);

  // Detect conceded / no play
  const bodyText = $('body').text();
  if (bodyText.includes('Match conceded by') || bodyText.includes('match conceded')) {
    return { skipped: true, reason: 'conceded' };
  }

  // The scorecard is the table with id="scorecard"
  const table = $('table#scorecard');
  if (!table.length) return null;

  const rows = table.find('tr').toArray();
  if (rows.length < 5) return null; // header + sub-header + 3 data rows

  // Row 0: empty cell + away team name (colspan=3, class="away")
  const awayTeam = $(rows[0]).find('th.away').text().trim();
  if (!awayTeam) return null;

  // Row 1: home team name (th.home) + 3 away pair cells (td.away)
  const row1cells = $(rows[1]).find('th, td').toArray();
  const homeTeam = $(row1cells[0]).text().trim();
  const awayPairs = [1, 2, 3].map(i => extractPair($, row1cells[i]));

  // Date from the summary table (first table): "28 April" — append year
  const summaryDateText = $('table:not(#scorecard) td').eq(1).text().trim();
  const date = summaryDateText ? `${summaryDateText} ${year}` : `${year}`;

  // Rows 2–4: home pair + 3 score cells
  const rubbers = [];
  for (let rowIdx = 2; rowIdx <= 4; rowIdx++) {
    const cells = $(rows[rowIdx]).find('td').toArray();
    const homePair = extractPair($, cells[0]);

    for (let colIdx = 0; colIdx < 3; colIdx++) {
      const scoreText = $(cells[colIdx + 1]).text().trim();
      const parts = scoreText.split('-').map(s => parseInt(s.trim(), 10));
      const homeGames = parts[0];
      const awayGames = parts[1];

      let winner;
      if (isNaN(homeGames) || isNaN(awayGames)) {
        winner = null;
      } else if (homeGames > awayGames) {
        winner = 'home';
      } else if (awayGames > homeGames) {
        winner = 'away';
      } else {
        winner = 'draw';
      }

      rubbers.push({
        rubber_order: (rowIdx - 2) * 3 + (colIdx + 1),
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
    season: year,
    division,
    date,
    home_team: homeTeam,
    away_team: awayTeam,
    source_url: `${baseUrl(year)}/result.php?id=${fixtureId}`,
    rubbers,
  };
}

async function scrapeFixture(fixtureId, division, year) {
  const url = `${baseUrl(year)}/result.php?id=${fixtureId}`;
  try {
    const html = await fetchHtml(url);
    return parseArchiveFixture(html, fixtureId, division, year);
  } catch (err) {
    console.warn(`  Failed ${fixtureId}: ${err.message}`);
    return null;
  }
}

async function scrapeSeason(year) {
  console.log(`\n=== Season ${year} ===`);

  // Collect fixture IDs from all division pages
  const fixturesByDivision = {};
  for (let div = 1; div <= DIVISIONS; div++) {
    process.stdout.write(`  Div ${div}: collecting...`);
    try {
      const ids = await getFixtureIdsForDivision(year, div);
      fixturesByDivision[div] = ids;
      console.log(` ${ids.length} fixtures`);
    } catch (err) {
      console.log(` ERROR: ${err.message}`);
      fixturesByDivision[div] = [];
    }
    await sleep(DELAY_MS);
  }

  // Scrape each fixture
  const allFixtures = [];
  const errors = [];

  for (let div = 1; div <= DIVISIONS; div++) {
    const ids = fixturesByDivision[div];
    console.log(`  Division ${div}: scraping ${ids.length} fixtures`);

    for (const id of ids) {
      process.stdout.write(`    ${id}...`);
      const fixture = await scrapeFixture(id, div, year);
      if (fixture && fixture.skipped) {
        console.log(` skipped (${fixture.reason})`);
      } else if (fixture && fixture.rubbers && fixture.rubbers.length === 9) {
        allFixtures.push(fixture);
        console.log(` ${fixture.home_team} v ${fixture.away_team}`);
      } else {
        console.log(` skipped (incomplete)`);
        errors.push(id);
      }
      await sleep(DELAY_MS);
    }
  }

  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));

  const output = {
    scraped_at: new Date().toISOString(),
    season: year,
    fixture_count: allFixtures.length,
    rubber_count: allFixtures.reduce((n, f) => n + f.rubbers.length, 0),
    skipped_fixture_ids: errors,
    fixtures: allFixtures,
  };

  const outFile = `fixtures_${year}.json`;
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`  → ${allFixtures.length} fixtures, ${output.rubber_count} rubbers saved to ${outFile}`);
  if (errors.length) console.log(`  → ${errors.length} skipped`);
}

async function main() {
  const targetYear = process.argv[2] ? parseInt(process.argv[2]) : null;
  const seasons = targetYear ? [targetYear] : SEASONS;

  for (const year of seasons) {
    await scrapeSeason(year);
  }

  console.log('\nAll done.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
