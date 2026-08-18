/**
 * League standings over HTTP — the shared source of truth for any app that
 * needs a York league table, so the scoring rules live in exactly one place.
 *
 * Backed by lib/league-table.js, which is validated cell-by-cell against
 * yorkmenstennisleague.co.uk (node scripts/validate-league-table.js).
 *
 *   /api/standings?league=mens&division=4          one division's table
 *   /api/standings?league=mens&team=Cawood%201     that team's division table
 *   /api/standings?league=mixed&team=Cawood        partial names allowed
 *   /api/standings?list=teams&league=mens          every team + its division
 *
 * Optional: &season=2025 (defaults to the latest), &asOf=2026-06-15 (the table
 * as it stood on that date, for tracking position over time).
 *
 * CORS is open because the data is public league results and browser apps on
 * other origins are the point of this endpoint.
 */

const { createClient } = require('@supabase/supabase-js');
const { buildLeagueTable, listTeams, getTeamStanding } = require('../lib/league-table');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // League results change a few times a week at most; let the CDN absorb the
  // repeat traffic while still refreshing quickly after an auto-update run.
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const query = req.query || Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  const league = query.league === 'mixed' ? 'mixed' : 'mens';
  const season = query.season ? parseInt(query.season, 10) : undefined;

  if (season != null && Number.isNaN(season)) {
    return send(res, 400, { error: `Could not parse season "${query.season}".` });
  }

  let asOf;
  if (query.asOf) {
    asOf = Date.parse(query.asOf);
    if (Number.isNaN(asOf)) {
      return send(res, 400, { error: `Could not parse asOf date "${query.asOf}". Use YYYY-MM-DD.` });
    }
  }

  try {
    if (query.list === 'teams') {
      const division = query.division ? parseInt(query.division, 10) : undefined;
      return send(res, 200, await listTeams(supabase, { league, season, division }));
    }

    // Resolve a team name to its division, so callers don't have to track
    // promotions and relegations to know which table to ask for.
    let division = query.division ? parseInt(query.division, 10) : undefined;
    let team = null;
    if (query.team) {
      const standing = await getTeamStanding(supabase, { league, team: query.team, season });
      if (standing.error) {
        return send(res, 404, { error: standing.error, candidates: standing.candidates || [] });
      }
      division = standing.division;
      team = standing.team;
    }

    if (division == null || Number.isNaN(division)) {
      return send(res, 400, { error: 'Provide either a division or a team.' });
    }

    const table = await buildLeagueTable(supabase, { league, division, season, asOf });
    if (table.standings.length === 0) {
      return send(res, 404, { error: `No fixtures found for ${league} division ${division} in ${table.season}.` });
    }
    return send(res, 200, team ? { ...table, team } : table);
  } catch (err) {
    return send(res, 500, { error: err.message });
  }
};
