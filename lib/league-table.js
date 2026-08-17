/**
 * League table construction for the York Men's and York & District Mixed leagues.
 *
 * This is the single source of truth for how a match is scored and how a
 * division table is ordered. Both leagues run different rule books — see
 * computeMensLeagueScore / computeMixedLeagueScore below — and the mens model
 * has been validated cell-by-cell against the official tables at
 * yorkmenstennisleague.co.uk (run `node scripts/validate-league-table.js`).
 *
 * Everything is derived from two Supabase tables per league:
 *   *_elo_fixtures   — one row per match: teams, date, status, game totals
 *   *_match_history  — one row per player per rubber (so 2 rows per pair)
 *
 * ⚠️ These tables are unofficial. Concession awards and league-admin points
 * penalties are not present in the source data and cannot be inferred, so a
 * wholly conceded fixture bumps PLD for both sides and awards nothing.
 */

const MENS_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025, 2026];
const MIXED_SEASONS = [2023, 2024, 2025, 2026];

/** What won/drawn/lost actually count, which differs between the two leagues. */
const SCORING_NOTE = {
  mens:
    'W/D/L count RUBBERS (9 per match, walkovers included). Points = rubbers won + drawn/2 ' +
    '+ games bonus (3 to the side winning more of the 108 games, 1.5 each at 54-54).',
  mixed:
    'W/D/L count MATCHES, each decided on total games won across the 9 rubbers. ' +
    'Points = 2 per win, 1 per draw.',
};

const UNOFFICIAL_NOTE =
  'Unofficial — computed from scraped results. League-admin points penalties and concession ' +
  'awards are not present in the source data, so a conceded fixture only increments played.';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function prefixFor(league) {
  return league === 'mixed' ? 'mixed_' : 'york_';
}

function seasonsFor(league) {
  return league === 'mixed' ? MIXED_SEASONS : MENS_SEASONS;
}

/**
 * Fixture dates arrive in two different shapes: the mens scraper writes
 * "26 Apr 2026" (and older rows use the full month name), the mixed scraper
 * writes MyDivision's "01.06.26". Returns a timestamp, or null if unparseable —
 * never sort these strings directly.
 */
function parseLeagueDate(dateStr) {
  if (!dateStr) return null;

  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(dateStr.trim());
  if (dotted) {
    const [, d, m, y] = dotted;
    const year = y.length === 2 ? 2000 + Number(y) : Number(y);
    return Date.UTC(year, Number(m) - 1, Number(d));
  }

  const worded = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(dateStr.trim());
  if (worded) {
    const [, d, mon, y] = worded;
    const month = MONTHS[mon.slice(0, 3).toLowerCase()];
    if (month == null) return null;
    return Date.UTC(Number(y), month, Number(d));
  }

  const fallback = new Date(dateStr).getTime();
  return Number.isNaN(fallback) ? null : fallback;
}

// ─── Match scoring ───────────────────────────────────────────────────────────

/**
 * York Mens League: a match is 9 rubbers (1 pt each, 0.5 each when drawn) plus
 * 3 bonus points to the side winning more of the 108 games — split 1.5 apiece
 * at 54–54. Totals always sum to 12.
 *
 * Conceded rubbers never appear in *_match_history (the scraper only records
 * rubbers that were played), but their games (12–0 each) ARE baked into the
 * fixture's game totals, so walkover wins are recoverable from the difference
 * between the fixture totals and the games summed off the recorded rubbers.
 */
function computeMensLeagueScore({
  rubberWins,
  rubberDraws,
  rubberLosses,
  playedGamesFor,
  playedGamesAgainst,
  totalGamesFor,
  totalGamesAgainst,
}) {
  const totalFor = totalGamesFor ?? 0;
  const totalAgainst = totalGamesAgainst ?? 0;
  const hasGames = totalFor > 0 || totalAgainst > 0;

  const walkoverWinsFor = hasGames ? Math.max(0, Math.round((totalFor - playedGamesFor) / 12)) : 0;
  const walkoverWinsAgainst = hasGames ? Math.max(0, Math.round((totalAgainst - playedGamesAgainst) / 12)) : 0;

  let bonusFor = 0;
  let bonusAgainst = 0;
  if (hasGames) {
    if (totalFor > totalAgainst) bonusFor = 3;
    else if (totalAgainst > totalFor) bonusAgainst = 3;
    else { bonusFor = 1.5; bonusAgainst = 1.5; }
  }

  const scoreFor = rubberWins + walkoverWinsFor + rubberDraws * 0.5 + bonusFor;
  const scoreAgainst = rubberLosses + walkoverWinsAgainst + rubberDraws * 0.5 + bonusAgainst;

  return {
    scoreFor,
    scoreAgainst,
    walkoverWinsFor,
    walkoverWinsAgainst,
    bonusFor,
    bonusAgainst,
    outcome: scoreFor > scoreAgainst ? 'W' : scoreFor < scoreAgainst ? 'L' : 'D',
  };
}

/**
 * York & District Mixed League: the match is decided purely on TOTAL GAMES won
 * across the 9 rubbers. Forfeited rubbers count 12–0 and are baked into the
 * fixture game totals, so always score from those — never from games summed off
 * *_match_history, which omits forfeits. 2 pts a win, 1 a draw.
 */
function computeMixedLeagueScore(gamesFor, gamesAgainst) {
  const gf = gamesFor ?? 0;
  const ga = gamesAgainst ?? 0;
  const outcome = gf > ga ? 'W' : gf < ga ? 'L' : 'D';
  return { gamesFor: gf, gamesAgainst: ga, outcome, points: outcome === 'W' ? 2 : outcome === 'D' ? 1 : 0 };
}

// ─── Supabase access ─────────────────────────────────────────────────────────

/** Supabase caps a select at 1000 rows — page until exhausted. */
async function fetchAll(supabase, table, columns, filters) {
  const rows = [];
  let from = 0;
  while (true) {
    let query = supabase.from(table).select(columns).range(from, from + 999);
    for (const [key, value] of Object.entries(filters)) {
      if (value != null) query = query.eq(key, value);
    }
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

/** Latest season that actually has fixtures, falling back to the known list. */
async function resolveSeason(supabase, league, season) {
  if (season != null) return season;
  const prefix = prefixFor(league);
  const { data } = await supabase
    .from(`${prefix}elo_fixtures`)
    .select('season')
    .order('season', { ascending: false })
    .limit(1);
  return data?.[0]?.season ?? seasonsFor(league).slice(-1)[0];
}

// ─── Table construction ──────────────────────────────────────────────────────

/**
 * Points a team loses for conceding a fixture. Not published as a rule, but
 * inferred and validated against the official tables: every team the site marks
 * with a trailing `*` sits exactly 6 points per concession below the sum of its
 * own W/D/L and bonus columns.
 */
const CONCESSION_PENALTY = 6;

function emptyStanding(team, division) {
  return {
    team,
    division,
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    gamesFor: 0,
    gamesAgainst: 0,
    bonus: 0,
    /** Points awarded by the league for a fixture an opponent conceded */
    awarded: 0,
    /** Points docked for conceding */
    penalty: 0,
    points: 0,
  };
}

/**
 * Collapse rubber rows (2 per pair, one per partner) into per-fixture-per-team
 * totals: rubbers won/drawn/lost and games for/against from the rubbers played.
 */
function aggregateRubbers(historyRows) {
  const seen = new Map();
  for (const r of historyRows) {
    const key = `${r.fixture_id}|${r.rubber_order}|${r.team}`;
    if (!seen.has(key)) seen.set(key, r);
  }

  const byFixtureTeam = new Map();
  for (const r of seen.values()) {
    const key = `${r.fixture_id}|${r.team}`;
    const entry = byFixtureTeam.get(key) || {
      fixtureId: r.fixture_id,
      team: r.team,
      wins: 0,
      draws: 0,
      losses: 0,
      gamesFor: 0,
      gamesAgainst: 0,
    };
    if (r.result === 'W') entry.wins++;
    else if (r.result === 'L') entry.losses++;
    else entry.draws++;
    entry.gamesFor += r.my_games || 0;
    entry.gamesAgainst += r.opp_games || 0;
    byFixtureTeam.set(key, entry);
  }
  return byFixtureTeam;
}

/**
 * Mixed tie-break ladder (league rules): teams level on points split on overall
 * games difference; teams STILL level re-order within their tie group on
 * (1) games difference then (2) rubbers won, both counted only from the
 * fixtures between the tied teams. Mutates `standings` in place.
 */
function resolveMixedTies(standings, fixtures, rubbersByFixtureTeam) {
  const gd = t => t.gamesFor - t.gamesAgainst;
  let i = 0;
  while (i < standings.length) {
    let j = i + 1;
    while (j < standings.length && standings[j].points === standings[i].points && gd(standings[j]) === gd(standings[i])) j++;

    if (j - i > 1) {
      const group = standings.slice(i, j);
      const inGroup = new Set(group.map(t => t.team));
      const h2h = new Map();
      const stat = team => {
        if (!h2h.has(team)) h2h.set(team, { gamesDiff: 0, rubbersWon: 0 });
        return h2h.get(team);
      };

      for (const f of fixtures) {
        if (!inGroup.has(f.home_team) || !inGroup.has(f.away_team)) continue;
        const hg = f.home_games ?? 0;
        const ag = f.away_games ?? 0;
        if (hg <= 0 && ag <= 0) continue;
        stat(f.home_team).gamesDiff += hg - ag;
        stat(f.away_team).gamesDiff += ag - hg;
        stat(f.home_team).rubbersWon += rubbersByFixtureTeam.get(`${f.fixture_id}|${f.home_team}`)?.wins ?? 0;
        stat(f.away_team).rubbersWon += rubbersByFixtureTeam.get(`${f.fixture_id}|${f.away_team}`)?.wins ?? 0;
      }

      group.sort((a, b) => {
        const sa = h2h.get(a.team) || { gamesDiff: 0, rubbersWon: 0 };
        const sb = h2h.get(b.team) || { gamesDiff: 0, rubbersWon: 0 };
        return sb.gamesDiff - sa.gamesDiff || sb.rubbersWon - sa.rubbersWon;
      });
      standings.splice(i, j - i, ...group);
    }
    i = j;
  }
}

/**
 * Build one division's table.
 *
 * `asOf` (timestamp) restricts to fixtures played on or before that date, which
 * is what makes position-over-time possible; omit it for the current table.
 * Teams are seeded from the fixture list rather than from match history, so a
 * team that has not played yet still appears with a blank row.
 */
async function buildLeagueTable(supabase, { league = 'mens', season, division, asOf } = {}) {
  if (division == null) throw new Error('division is required');
  const prefix = prefixFor(league);
  const resolvedSeason = await resolveSeason(supabase, league, season);

  const [fixtures, history] = await Promise.all([
    fetchAll(
      supabase,
      `${prefix}elo_fixtures`,
      'fixture_id, home_team, away_team, home_games, away_games, home_points, away_points, conceded_by, date, status, is_conceded',
      { season: resolvedSeason, division }
    ),
    fetchAll(
      supabase,
      `${prefix}match_history`,
      'fixture_id, rubber_order, team, result, my_games, opp_games',
      { season: resolvedSeason, division }
    ),
  ]);

  if (fixtures.length === 0) {
    return {
      league, season: resolvedSeason, division, standings: [],
      fixturesPlayed: 0, fixturesTotal: 0,
      scoring: SCORING_NOTE[league === 'mixed' ? 'mixed' : 'mens'],
      note: UNOFFICIAL_NOTE,
    };
  }

  for (const f of fixtures) f.timestamp = parseLeagueDate(f.date);

  const inWindow = f => asOf == null || (f.timestamp != null && f.timestamp <= asOf);
  const countedFixtures = fixtures.filter(inWindow);
  const countedIds = new Set(countedFixtures.map(f => f.fixture_id));

  const rubbersByFixtureTeam = aggregateRubbers(history.filter(r => countedIds.has(r.fixture_id)));

  const table = new Map();
  for (const f of fixtures) {
    for (const team of [f.home_team, f.away_team]) {
      if (team && !table.has(team)) table.set(team, emptyStanding(team, division));
    }
  }

  if (league === 'mixed') {
    // Decided on total games from the fixture row. `status` alone is unreliable —
    // the scraper can mark a future fixture played with no games on the board.
    for (const f of countedFixtures) {
      const homeGames = f.home_games ?? 0;
      const awayGames = f.away_games ?? 0;
      if (homeGames <= 0 && awayGames <= 0) continue;

      const score = computeMixedLeagueScore(homeGames, awayGames);
      const home = table.get(f.home_team);
      const away = table.get(f.away_team);
      home.played++;
      away.played++;
      home.gamesFor += homeGames;
      home.gamesAgainst += awayGames;
      away.gamesFor += awayGames;
      away.gamesAgainst += homeGames;
      if (score.outcome === 'W') { home.won++; away.lost++; }
      else if (score.outcome === 'L') { home.lost++; away.won++; }
      else { home.drawn++; away.drawn++; }
    }
    for (const t of table.values()) t.points = t.won * 2 + t.drawn;
  } else {
    // Official mens model: W/D/L count RUBBERS (walkovers included), plus the
    // games bonus. Points = rubbers won + drawn/2 + bonus.
    //
    // Driven by the fixture list rather than by the rubber rows, because a
    // wholly conceded match has no rubbers at all yet still carries a league
    // award — the fixture's game totals are all there is to score it from.
    const NO_RUBBERS = { wins: 0, draws: 0, losses: 0, gamesFor: 0, gamesAgainst: 0 };

    for (const f of countedFixtures) {
      const homeGames = f.home_games ?? 0;
      const awayGames = f.away_games ?? 0;
      if (homeGames <= 0 && awayGames <= 0 && !f.is_conceded) continue;

      // A concession has no scorecard to score from, and the points the league
      // awards vary case by case (6 for 55 games won, 10.5 for 76, 3 for 40 —
      // no formula fits), so take the published match points as given. The
      // official table adds them straight to PTS without touching its own
      // W/D/L or BONUS columns, and docks the conceding side.
      if (f.is_conceded) {
        for (const isHome of [true, false]) {
          const team = isHome ? f.home_team : f.away_team;
          const t = table.get(team);
          if (!t) continue;
          t.played++;
          t.gamesFor += isHome ? homeGames : awayGames;
          t.gamesAgainst += isHome ? awayGames : homeGames;
          t.awarded += (isHome ? f.home_points : f.away_points) ?? 0;
          if (f.conceded_by === (isHome ? 'home' : 'away')) t.penalty += CONCESSION_PENALTY;
        }
        continue;
      }

      for (const isHome of [true, false]) {
        const team = isHome ? f.home_team : f.away_team;
        const t = table.get(team);
        if (!t) continue;

        const entry = rubbersByFixtureTeam.get(`${f.fixture_id}|${team}`) || NO_RUBBERS;
        const totalGamesFor = (isHome ? f.home_games : f.away_games) ?? entry.gamesFor;
        const totalGamesAgainst = (isHome ? f.away_games : f.home_games) ?? entry.gamesAgainst;

        const score = computeMensLeagueScore({
          rubberWins: entry.wins,
          rubberDraws: entry.draws,
          rubberLosses: entry.losses,
          playedGamesFor: entry.gamesFor,
          playedGamesAgainst: entry.gamesAgainst,
          totalGamesFor,
          totalGamesAgainst,
        });

        t.played++;
        t.won += entry.wins + score.walkoverWinsFor;
        t.drawn += entry.draws;
        t.lost += entry.losses + score.walkoverWinsAgainst;
        t.gamesFor += totalGamesFor;
        t.gamesAgainst += totalGamesAgainst;
        t.bonus += score.bonusFor;
      }
    }

    for (const t of table.values()) t.points = t.won + t.drawn / 2 + t.bonus + t.awarded - t.penalty;
  }

  const standings = [...table.values()].sort(
    (a, b) => b.points - a.points || (b.gamesFor - b.gamesAgainst) - (a.gamesFor - a.gamesAgainst)
  );
  if (league === 'mixed') resolveMixedTies(standings, countedFixtures, rubbersByFixtureTeam);

  standings.forEach((t, i) => {
    t.position = i + 1;
    t.gamesDifference = t.gamesFor - t.gamesAgainst;
    t.pointsPerMatch = t.played > 0 ? Math.round((t.points / t.played) * 100) / 100 : null;
  });

  const playedInWindow = countedFixtures.filter(
    f => (f.home_games ?? 0) > 0 || (f.away_games ?? 0) > 0 || f.is_conceded
  ).length;

  return {
    league,
    season: resolvedSeason,
    division,
    standings,
    fixturesPlayed: playedInWindow,
    fixturesTotal: fixtures.length,
    asOf: asOf != null ? new Date(asOf).toISOString().slice(0, 10) : null,
    scoring: SCORING_NOTE[league === 'mixed' ? 'mixed' : 'mens'],
    note: UNOFFICIAL_NOTE,
  };
}

// ─── Team lookups ────────────────────────────────────────────────────────────

/** Every team in a season, with its division. */
async function listTeams(supabase, { league = 'mens', season, division } = {}) {
  const prefix = prefixFor(league);
  const resolvedSeason = await resolveSeason(supabase, league, season);
  const fixtures = await fetchAll(
    supabase,
    `${prefix}elo_fixtures`,
    'home_team, away_team, division',
    { season: resolvedSeason, division }
  );

  const teams = new Map();
  for (const f of fixtures) {
    for (const team of [f.home_team, f.away_team]) {
      if (team && !teams.has(team)) teams.set(team, { team, division: f.division });
    }
  }
  return {
    league,
    season: resolvedSeason,
    teams: [...teams.values()].sort((a, b) => a.division - b.division || a.team.localeCompare(b.team)),
  };
}

/**
 * Resolve a user-supplied team name to a real one: exact match first, then
 * case-insensitive, then substring (only when it is unambiguous).
 */
function resolveTeamName(query, teams) {
  const names = teams.map(t => t.team);
  const exact = names.find(n => n === query);
  if (exact) return { name: exact };

  const q = query.toLowerCase().trim();
  const insensitive = names.filter(n => n.toLowerCase() === q);
  if (insensitive.length === 1) return { name: insensitive[0] };

  const partial = names.filter(n => n.toLowerCase().includes(q));
  if (partial.length === 1) return { name: partial[0] };
  if (partial.length > 1) return { name: null, candidates: partial };
  return { name: null, candidates: [] };
}

/**
 * One team's league standing plus the context that makes it meaningful: the
 * teams immediately above and below, recent results and remaining fixtures.
 */
async function getTeamStanding(supabase, { league = 'mens', team, season, formCount = 5 } = {}) {
  if (!team) throw new Error('team is required');
  const prefix = prefixFor(league);
  const resolvedSeason = await resolveSeason(supabase, league, season);

  const { teams } = await listTeams(supabase, { league, season: resolvedSeason });
  const resolved = resolveTeamName(team, teams);
  if (!resolved.name) {
    return {
      error: `No team matching "${team}" in the ${league} league for ${resolvedSeason}.`,
      candidates: resolved.candidates,
    };
  }

  const teamName = resolved.name;
  const division = teams.find(t => t.team === teamName).division;
  const table = await buildLeagueTable(supabase, { league, season: resolvedSeason, division });
  const standing = table.standings.find(t => t.team === teamName);
  const index = table.standings.indexOf(standing);

  const fixtures = await fetchAll(
    supabase,
    `${prefix}elo_fixtures`,
    'fixture_id, home_team, away_team, home_games, away_games, home_points, away_points, conceded_by, date, status, is_conceded',
    { season: resolvedSeason, division }
  );
  const ours = fixtures
    .filter(f => f.home_team === teamName || f.away_team === teamName)
    .map(f => ({ ...f, timestamp: parseLeagueDate(f.date) }))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));

  const history = await fetchAll(
    supabase,
    `${prefix}match_history`,
    'fixture_id, rubber_order, team, result, my_games, opp_games',
    { season: resolvedSeason, division }
  );
  const rubbers = aggregateRubbers(history);

  const played = [];
  const remaining = [];
  for (const f of ours) {
    const isHome = f.home_team === teamName;
    const opponent = isHome ? f.away_team : f.home_team;
    const gamesFor = (isHome ? f.home_games : f.away_games) ?? 0;
    const gamesAgainst = (isHome ? f.away_games : f.home_games) ?? 0;
    const hasResult = gamesFor > 0 || gamesAgainst > 0 || f.is_conceded;

    if (!hasResult) {
      remaining.push({ date: f.date, opponent, venue: isHome ? 'home' : 'away' });
      continue;
    }

    const entry = rubbers.get(`${f.fixture_id}|${teamName}`);
    let outcome = null;
    let matchScore = null;
    if (f.is_conceded) {
      // No scorecard exists — report the league's award instead.
      const ourPoints = (isHome ? f.home_points : f.away_points) ?? 0;
      const theirPoints = (isHome ? f.away_points : f.home_points) ?? 0;
      const weConceded = f.conceded_by === (isHome ? 'home' : 'away');
      outcome = ourPoints > theirPoints ? 'W' : ourPoints < theirPoints ? 'L' : 'D';
      matchScore = `${ourPoints}-${theirPoints} (${weConceded ? 'conceded' : 'opponent conceded'})`;
    } else if (league === 'mixed') {
      const score = computeMixedLeagueScore(gamesFor, gamesAgainst);
      outcome = score.outcome;
      matchScore = `${gamesFor}-${gamesAgainst} games`;
    } else if (entry) {
      const score = computeMensLeagueScore({
        rubberWins: entry.wins,
        rubberDraws: entry.draws,
        rubberLosses: entry.losses,
        playedGamesFor: entry.gamesFor,
        playedGamesAgainst: entry.gamesAgainst,
        totalGamesFor: gamesFor,
        totalGamesAgainst: gamesAgainst,
      });
      outcome = score.outcome;
      matchScore = `${score.scoreFor}-${score.scoreAgainst} (${gamesFor}-${gamesAgainst} games)`;
    }

    played.push({ date: f.date, opponent, venue: isHome ? 'home' : 'away', score: matchScore, outcome, conceded: f.is_conceded || undefined });
  }

  const form = played.slice(-formCount).reverse();

  return {
    league,
    season: resolvedSeason,
    division,
    team: teamName,
    position: standing.position,
    outOf: table.standings.length,
    played: standing.played,
    won: standing.won,
    drawn: standing.drawn,
    lost: standing.lost,
    gamesFor: standing.gamesFor,
    gamesAgainst: standing.gamesAgainst,
    gamesDifference: standing.gamesDifference,
    bonus: league === 'mixed' ? undefined : standing.bonus,
    awarded: standing.awarded || undefined,
    penalty: standing.penalty || undefined,
    points: standing.points,
    pointsPerMatch: standing.pointsPerMatch,
    above: index > 0
      ? { team: table.standings[index - 1].team, points: table.standings[index - 1].points, gap: Math.round((table.standings[index - 1].points - standing.points) * 10) / 10 }
      : null,
    below: index < table.standings.length - 1
      ? { team: table.standings[index + 1].team, points: table.standings[index + 1].points, gap: Math.round((standing.points - table.standings[index + 1].points) * 10) / 10 }
      : null,
    form: form.map(f => f.outcome).join(''),
    recentMatches: form,
    remainingFixtures: remaining,
    scoring: SCORING_NOTE[league === 'mixed' ? 'mixed' : 'mens'],
    note: UNOFFICIAL_NOTE,
  };
}

module.exports = {
  MENS_SEASONS,
  MIXED_SEASONS,
  SCORING_NOTE,
  UNOFFICIAL_NOTE,
  prefixFor,
  seasonsFor,
  parseLeagueDate,
  computeMensLeagueScore,
  computeMixedLeagueScore,
  buildLeagueTable,
  listTeams,
  resolveTeamName,
  getTeamStanding,
};
