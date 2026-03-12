const { createClient } = require('@supabase/supabase-js');

// Known seasons in ascending order — update when a new season is scraped
const ALL_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];

async function fetchHistory(supabase, minSeason) {
  let rows = [], from = 0;
  while (true) {
    let q = supabase
      .from('york_match_history')
      .select('player_name, team, season, result, division, date, fixture_id')
      .range(from, from + 999);
    if (minSeason != null) q = q.gte('season', minSeason);
    const { data, error } = await q;
    if (error) return { rows: null, error };
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return { rows, error: null };
}

async function fetchPlayers(supabase) {
  let rows = [], from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('york_players')
      .select('name, rating')
      .range(from, from + 999);
    if (error) return { rows: null, error };
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return { rows, error: null };
}

// Build per-player per-season fixture list (one entry per distinct fixture, not per rubber).
// Each fixture = one match = 3 rubbers, so we deduplicate by fixture_id.
function buildPlayerFixtures(historyRows) {
  // player → season → fixtureId → {team, division, date}
  const pfMap = {};
  for (const r of historyRows) {
    if (!r.player_name || !r.team || !r.fixture_id || !r.season || !r.date) continue;
    if (!pfMap[r.player_name]) pfMap[r.player_name] = {};
    if (!pfMap[r.player_name][r.season]) pfMap[r.player_name][r.season] = new Map();
    const fid = String(r.fixture_id);
    if (!pfMap[r.player_name][r.season].has(fid)) {
      pfMap[r.player_name][r.season].set(fid, {
        team: r.team,
        division: r.division,
        date: r.date,
        ts: new Date(r.date).getTime(),
      });
    }
  }

  // Convert to sorted arrays per player per season
  const result = {};
  for (const [player, seasons] of Object.entries(pfMap)) {
    result[player] = {};
    for (const [season, fixtureMap] of Object.entries(seasons)) {
      result[player][season] = [...fixtureMap.values()].sort((a, b) => a.ts - b.ts);
    }
  }
  return result;
}

// Detect ringer/cheat status for a player in a lower-division team.
// Rule: once a player has played 3+ MATCHES (fixtures) for a higher-division
// team in the same season, they are ineligible to play down.
// - RINGER:  played for both teams in same season, but never illegally
// - CHEAT:   played for the lower team AFTER accumulating 3+ matches for higher team
function getRingerInfo(pname, teamName, teamDivision, playerFixtures) {
  const seasonData = playerFixtures[pname];
  if (!seasonData || teamDivision == null) return null;

  const seasonResults = [];

  for (const [season, fixtures] of Object.entries(seasonData)) {
    const playedForThisTeam = fixtures.some(f => f.team === teamName);
    if (!playedForThisTeam) continue;

    // Identify all higher-division teams played for in this season
    const higherTeamTotals = {}; // team → {division, matchCount}
    for (const f of fixtures) {
      if (f.team !== teamName && f.division != null && f.division < teamDivision) {
        if (!higherTeamTotals[f.team]) higherTeamTotals[f.team] = { division: f.division, matchCount: 0 };
        higherTeamTotals[f.team].matchCount++;
      }
    }
    if (Object.keys(higherTeamTotals).length === 0) continue; // no higher teams

    // Walk fixtures chronologically to detect cheating (played down after 3+ higher matches)
    const runningHigherCount = {}; // team → cumulative match count at each point
    let seasonCheating = false;
    let cheatTrigger = null; // the higher team that caused ineligibility

    for (const f of fixtures) {
      if (f.team === teamName) {
        // Playing for the lower team — check if any higher team is at 3+
        for (const [hTeam, count] of Object.entries(runningHigherCount)) {
          if (count >= 3) {
            seasonCheating = true;
            cheatTrigger = {
              team: hTeam,
              division: higherTeamTotals[hTeam]?.division,
              countAtTime: count,
            };
            break;
          }
        }
      } else if (f.division != null && f.division < teamDivision) {
        // Playing for a higher team — accumulate count
        runningHigherCount[f.team] = (runningHigherCount[f.team] || 0) + 1;
      }
    }

    // Primary higher team: the cheat trigger if cheating, otherwise most matches
    const sortedHigher = Object.entries(higherTeamTotals)
      .map(([t, v]) => ({ team: t, division: v.division, matchCount: v.matchCount }))
      .sort((a, b) => {
        if (cheatTrigger) {
          const aT = a.team === cheatTrigger.team ? 1 : 0;
          const bT = b.team === cheatTrigger.team ? 1 : 0;
          if (aT !== bT) return bT - aT;
        }
        return b.matchCount - a.matchCount;
      });

    seasonResults.push({
      season: parseInt(season),
      isCheating: seasonCheating,
      cheatTrigger,
      primaryHigherTeam: sortedHigher[0],
      allHigherTeams: sortedHigher,
    });
  }

  if (seasonResults.length === 0) return null;

  seasonResults.sort((a, b) => (b.isCheating ? 1 : 0) - (a.isCheating ? 1 : 0));
  const primary = seasonResults[0];

  return {
    isCheating: seasonResults.some(s => s.isCheating),
    primaryTeam: primary.primaryHigherTeam.team,
    primaryDivision: primary.primaryHigherTeam.division,
    primaryMatchCount: primary.primaryHigherTeam.matchCount,
    primarySeason: primary.season,
    cheatTrigger: primary.cheatTrigger,
    allSeasons: seasonResults,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const query = req.query || Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);

  const rawSeasons = query.seasons !== undefined ? parseInt(query.seasons) : 2;
  const seasonCount = Math.min(Math.max(isNaN(rawSeasons) ? 2 : rawSeasons, 0), ALL_SEASONS.length);
  const minAppearances = Math.min(Math.max(parseInt(query.minAppearances) || 3, 1), 100);

  const includedSeasons = seasonCount === 0
    ? ALL_SEASONS
    : ALL_SEASONS.slice(-seasonCount);
  const minSeason = seasonCount === 0 ? null : includedSeasons[0];

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const [{ rows: historyRows, error: histErr }, { rows: playerRows, error: playerErr }] =
    await Promise.all([fetchHistory(supabase, minSeason), fetchPlayers(supabase)]);

  if (histErr) { res.statusCode = 500; res.end(JSON.stringify({ error: histErr.message })); return; }
  if (playerErr) { res.statusCode = 500; res.end(JSON.stringify({ error: playerErr.message })); return; }

  const ratingMap = {};
  for (const p of playerRows) ratingMap[p.name] = p.rating;

  // Team aggregation (rubber-level, for squad stats)
  const teamData = {};
  for (const r of historyRows) {
    if (!r.team || !r.player_name) continue;
    if (!teamData[r.team]) {
      teamData[r.team] = { players: new Map(), wins: 0, losses: 0, draws: 0, division: r.division || null };
    }
    const td = teamData[r.team];
    if (!td.players.has(r.player_name)) {
      td.players.set(r.player_name, { appearances: 0, wins: 0, losses: 0, draws: 0 });
    }
    const pd = td.players.get(r.player_name);
    pd.appearances++;
    if (r.result === 'W')      { pd.wins++;   td.wins++;   }
    else if (r.result === 'L') { pd.losses++; td.losses++; }
    else if (r.result === 'D') { pd.draws++;  td.draws++;  }
  }

  // Fixture-level data for ringer detection (counts matches, not rubbers)
  const playerFixtures = buildPlayerFixtures(historyRows);

  // Build output
  const teams = [];
  for (const [teamName, td] of Object.entries(teamData)) {
    const playerList = [];
    for (const [pname, pdata] of td.players.entries()) {
      if (pdata.appearances < minAppearances) continue;
      const currentRating = ratingMap[pname];
      if (currentRating == null) continue;

      playerList.push({
        name: pname,
        rating: Math.round(currentRating),
        appearances: pdata.appearances,
        winRate: pdata.appearances > 0
          ? Math.round(((pdata.wins + 0.5 * pdata.draws) / pdata.appearances) * 100)
          : null,
        ringerInfo: getRingerInfo(pname, teamName, td.division, playerFixtures),
      });
    }
    if (playerList.length === 0) continue;

    playerList.sort((a, b) => b.rating - a.rating);
    const ratings = playerList.map(p => p.rating);
    const avgRating = Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length);
    const totalRubbers = td.wins + td.losses + td.draws;

    teams.push({
      name: teamName,
      division: td.division,
      avgRating,
      topRating: ratings[0],
      playerCount: playerList.length,
      winRate: totalRubbers > 0
        ? Math.round(((td.wins + 0.5 * td.draws) / totalRubbers) * 100)
        : null,
      totalRubbers,
      players: playerList,
    });
  }

  teams.sort((a, b) => (a.division || 99) - (b.division || 99) || b.avgRating - a.avgRating);

  res.end(JSON.stringify({
    teams,
    seasonCount,
    includedSeasons,
    minAppearances,
    teamCount: teams.length,
  }));
};
