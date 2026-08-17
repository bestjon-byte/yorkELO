const cheerio = require('cheerio');
const fs = require('fs');

const BASE_URL = 'https://www.yorkmenstennisleague.co.uk';
const SEASON = 2026;
const DIVISIONS = 8;
const DELAY_MS = 1000;
const USER_AGENT = 'York-ELO-Tracker-Bot (Automated ELO Rating System; contact: your-email@example.com)';

const OUT_PATH = `fixtures_${SEASON}.json`;
const RECHECK_DAYS = 7;

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

/** Total games on one side of a cached fixture's scorecard. */
function sumRubberGames(fixture, field) {
  return (fixture.rubbers || []).reduce((sum, r) => sum + (r[field] || 0), 0);
}

async function getFixturesFromDivisionPage(division) {
  const url = `${BASE_URL}/divisions/${division}/Division_${division}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const fixtures = [];
  $('tr').each((_, tr) => {
    const row = $(tr);
    const link = row.find('a[href*="/fixtures/"]');
    if (link.length) {
      const href = link.attr('href');
      const id = parseInt(href.match(/\/fixtures\/(\d+)$/)[1], 10);
      
      const cells = row.find('td').toArray();
      let date = null, time = null, homeTeam = null, awayTeam = null;

      $(cells).each((i, td) => {
        const text = $(td).text().trim();
        // Full date: "26 April 2026"
        if (text.match(/\d+\s+\w+\s+\d{4}/)) date = text;
        // Short date: "26 Apr" — append season year so RECHECK_DAYS logic works
        else if (text.match(/^\d{1,2}\s+[A-Za-z]{3}$/)) date = `${text} ${SEASON}`;
        else if (text.match(/\d{2}:\d{2}/)) time = text;
      });

      let homeGames = null, awayGames = null, homePoints = null, awayPoints = null, concededBy = null;
      if (cells.length >= 4) {
        homeTeam = $(cells[1]).text().trim() || null;
        awayTeam = $(cells[3]).text().trim() || null;

        // The middle cell carries the authoritative match score as
        // "9.5 (64) - 2.5 (44)" — points out of 12, then games — followed by a
        // status marker ("[P]" played, "[E ConA]" conceded). These game totals
        // INCLUDE games awarded for conceded rubbers, which never appear on the
        // fixture scorecard, so they are the only place a walkover award can be
        // read from. Do not anchor the match: the marker trails the score.
        const scoreText = $(cells[2]).text().trim();
        const score = /^([\d.]+)\s*\((\d+)\)\s*-\s*([\d.]+)\s*\((\d+)\)/.exec(scoreText);
        if (score) {
          homePoints = parseFloat(score[1]);
          homeGames = parseInt(score[2], 10);
          awayPoints = parseFloat(score[3]);
          awayGames = parseInt(score[4], 10);
        }
        // "[E ConA]" / "[E ConH]" marks which side conceded. The points the
        // league awards for a concession are a committee decision that varies
        // case by case (6 for 55 games, 10.5 for 76, 3 for 40 — no formula
        // fits), so the published points above are the only reliable source.
        const marker = /\[\s*E\s+Con([AH])\s*\]/i.exec(scoreText);
        if (marker) concededBy = marker[1].toUpperCase() === 'A' ? 'away' : 'home';
      }

      if (id) {
        fixtures.push({ id, date, time, home_team: homeTeam, away_team: awayTeam, home_games: homeGames, away_games: awayGames, home_points: homePoints, away_points: awayPoints, conceded_by: concededBy });
      }
    }
  });

  return fixtures;
}

function parseFixture(html, fixtureId, division) {
  const $ = cheerio.load(html);
  const dateText = $('main p').first().text().trim();
  const date = dateText.split(' - ')[0].trim();
  const mainText = $('main').text();
  if (mainText.includes('Match conceded by')) return { skipped: true, reason: 'conceded', date };

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
    const players = (cell.html() || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').split('\n').map(s => s.trim()).filter(Boolean);
    return { player1: players[0] || '', player2: players[1] || '' };
  });

  const rubbers = [];
  for (let rowIdx = 1; rowIdx <= 3; rowIdx++) {
    const cells = $(rows[rowIdx]).find('td').toArray();
    const pairCell = $(cells[0]);
    const homePlayers = (pairCell.html() || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').split('\n').map(s => s.trim()).filter(Boolean);
    const homePair = { player1: homePlayers[0] || '', player2: homePlayers[1] || '' };

    for (let colIdx = 0; colIdx < 3; colIdx++) {
      const scoreText = $(cells[colIdx + 1]).text().trim();
      const scoreParts = scoreText.split('-').map(s => parseInt(s.trim(), 10));
      const homeGames = scoreParts[0], awayGames = scoreParts[1];
      let winner = null;
      if (!isNaN(homeGames) && !isNaN(awayGames)) {
        if (homeGames > awayGames) winner = 'home';
        else if (awayGames > homeGames) winner = 'away';
        else winner = 'draw';
      }
      rubbers.push({
        rubber_order: (rowIdx - 1) * 3 + (colIdx + 1),
        home_player1: homePair.player1, home_player2: homePair.player2,
        away_player1: awayPairs[colIdx].player1, away_player2: awayPairs[colIdx].player2,
        home_games: homeGames, away_games: awayGames, winner,
      });
    }
  }
  return { fixture_id: fixtureId, season: SEASON, division, date, home_team: homeTeam, away_team: awayTeam, source_url: `${BASE_URL}/fixtures/${fixtureId}`, rubbers };
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
  const now = new Date();
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  let totalDivisionLinks = 0;

  for (let div = 1; div <= DIVISIONS; div++) {
    process.stdout.write(`Division ${div}: fetching season schedule...`);
    const divisionFixtures = await getFixturesFromDivisionPage(div);
    console.log(` ${divisionFixtures.length} matches found`);
    totalDivisionLinks += divisionFixtures.length;

    for (const item of divisionFixtures) {
      const id = item.id;
      const existing = existingMap.get(id);
      const dateStr = item.date;
      const timeStr = item.time;
      const homeTeam = item.home_team;
      const awayTeam = item.away_team;

      let isRecent = false, isFuture = false;
      if (dateStr) {
        const matchDate = new Date(dateStr);
        isFuture = matchDate > today;
        const diffDays = (now - matchDate) / (1000 * 60 * 60 * 24);
        isRecent = diffDays <= RECHECK_DAYS && diffDays >= 0;
      }

      if (isFuture) {
        allFixtures.push({ fixture_id: id, date: dateStr, time: timeStr, home_team: homeTeam || existing?.home_team || null, away_team: awayTeam || existing?.away_team || null, division: div, rubbers: [] });
        continue;
      }

      // Treat fixtures with rubbers but no player names as "no results yet"
      const hasResults = existing && (existing.rubbers || []).some(r => r.home_player1 || r.away_player1);

      // Results can be amended upstream long after we first captured them
      // (rubbers re-scored as walkovers, corrections). Compare the cached
      // scorecard against the division page's match score — if they disagree
      // the cache is stale and must be re-fetched however old the fixture is,
      // otherwise `hasResults && !isRecent` would freeze the old score forever.
      const cachedStale = hasResults && item.home_games != null &&
        (sumRubberGames(existing, 'home_games') !== item.home_games ||
         sumRubberGames(existing, 'away_games') !== item.away_games);

      if (existing && hasResults && !isRecent && !cachedStale) {
        allFixtures.push({ ...existing, date: dateStr || existing.date, time: timeStr || existing.time, home_team: homeTeam || existing.home_team, away_team: awayTeam || existing.away_team, home_games: item.home_games ?? existing.home_games ?? null, away_games: item.away_games ?? existing.away_games ?? null, home_points: item.home_points ?? existing.home_points ?? null, away_points: item.away_points ?? existing.away_points ?? null, conceded_by: item.conceded_by ?? existing.conceded_by ?? null });
        continue;
      }
      if (cachedStale) {
        console.log(`  Fixture ${id}: cached score ${sumRubberGames(existing, 'home_games')}-${sumRubberGames(existing, 'away_games')} no longer matches the division page (${item.home_games}-${item.away_games}) — re-fetching`);
      }

      process.stdout.write(`  Fixture ${id}${isRecent ? ' (re-checking)' : ''}...`);
      try {
        const html = await fetchHtml(`${BASE_URL}/fixtures/${id}`);
        const fixture = parseFixture(html, id, div);
        if (fixture && fixture.skipped) {
          // A conceded fixture has no scorecard to parse, but the league still
          // awards the non-offending side games — carry the division page's
          // totals through so the league table can credit them.
          const award = item.home_games != null ? ` — ${item.home_games}-${item.away_games} awarded` : '';
          console.log(` skipped (${fixture.reason})${award}`);
          allFixtures.push({ fixture_id: id, season: SEASON, division: div, date: fixture.date || dateStr, time: timeStr, home_team: homeTeam, away_team: awayTeam, source_url: `${BASE_URL}/fixtures/${id}`, skipped: true, reason: fixture.reason, home_games: item.home_games, away_games: item.away_games, home_points: item.home_points, away_points: item.away_points, conceded_by: item.conceded_by, rubbers: [] });
        } else if (fixture && fixture.rubbers && fixture.rubbers.length > 0) {
          allFixtures.push({ ...fixture, time: timeStr, home_team: homeTeam || fixture.home_team, away_team: awayTeam || fixture.away_team, home_games: item.home_games, away_games: item.away_games, home_points: item.home_points, away_points: item.away_points, conceded_by: item.conceded_by });
          console.log(` ${homeTeam || fixture.home_team} v ${awayTeam || fixture.away_team} (${fixture.rubbers.length} rubbers)`);
        } else {
          console.log(' no scorecard yet');
          allFixtures.push({ fixture_id: id, date: dateStr, time: timeStr, home_team: homeTeam, away_team: awayTeam, division: div, home_games: item.home_games, away_games: item.away_games, home_points: item.home_points, away_points: item.away_points, conceded_by: item.conceded_by, rubbers: [] });
          errors.push(id);
        }
      } catch (err) {
        console.log(` failed: ${err.message}`);
        if (existing) allFixtures.push(existing);
        errors.push(id);
      }
      await sleep(DELAY_MS);
    }
    await sleep(DELAY_MS);
  }

  // A genuinely fixture-free season would still list upcoming/empty rows on
  // the division pages — 0 links across every division means the site didn't
  // respond as expected (blocked, down, markup changed), not that the season
  // is actually empty. Bail out rather than overwrite known-good data with it.
  if (totalDivisionLinks === 0 && existingData.fixtures.length > 0) {
    throw new Error(`All ${DIVISIONS} division pages returned 0 fixture links, but ${existingData.fixtures.length} were already known — treating as a failed scrape, not a real 0. Leaving ${OUT_PATH} untouched.`);
  }

  allFixtures.sort((a, b) => new Date(a.date) - new Date(b.date));
  const output = { scraped_at: new Date().toISOString(), season: SEASON, fixture_count: allFixtures.filter(f => f.rubbers && f.rubbers.length > 0).length, rubber_count: allFixtures.reduce((n, f) => n + (f.rubbers ? f.rubbers.length : 0), 0), skipped_fixture_ids: errors, fixtures: allFixtures };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(`\nDone. ${output.fixture_count} fixtures with results saved to ${OUT_PATH}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
