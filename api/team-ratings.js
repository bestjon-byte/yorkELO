const { createClient } = require('@supabase/supabase-js');

// Known seasons in ascending order — update when a new season is scraped
const ALL_SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];

async function fetchHistory(supabase, minSeason) {
  let rows = [], from = 0;
  while (true) {
    let q = supabase
      .from('york_match_history')
      .select('player_name, team, season, result, division')
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

// Detect ringer status for a player appearing in a given team.
// A ringer is someone who also played for a higher-division team in the SAME season.
// Cheating = they had 3+ games for the higher team (league eligibility rule).
function getRingerInfo(pname, teamName, teamDivision, playerSeasonTeams) {
  const seasonTeams = playerSeasonTeams[pname];
  if (!seasonTeams || teamDivision == null) return null;

  const instances = [];
  for (const [season, teamMap] of Object.entries(seasonTeams)) {
    if (!teamMap.has(teamName)) continue; // didn't play for this team in this season
    for (const [otherTeam, otherData] of teamMap.entries()) {
      if (otherTeam === teamName) continue;
      if (otherData.division != null && otherData.division < teamDivision) {
        instances.push({
          team: otherTeam,
          division: otherData.division,
          appearances: otherData.appearances,
          season: parseInt(season),
          isCheating: otherData.appearances >= 3,
        });
      }
    }
  }

  if (instances.length === 0) return null;

  // Sort: cheating instances first, then by appearances desc
  instances.sort((a, b) =>
    (b.isCheating ? 1 : 0) - (a.isCheating ? 1 : 0) || b.appearances - a.appearances
  );

  return {
    primary: instances[0],
    allInstances: instances,
    isCheating: instances.some(t => t.isCheating),
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

  // Build team aggregation AND per-player-per-season team map for ringer detection
  const teamData = {};
  const playerSeasonTeams = {}; // playerName → season → Map<teamName, {division, appearances}>

  for (const r of historyRows) {
    if (!r.team || !r.player_name) continue;

    // Team aggregation
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

    // Ringer detection: track per player, per season, per team
    if (r.season) {
      if (!playerSeasonTeams[r.player_name]) playerSeasonTeams[r.player_name] = {};
      if (!playerSeasonTeams[r.player_name][r.season]) playerSeasonTeams[r.player_name][r.season] = new Map();
      const sm = playerSeasonTeams[r.player_name][r.season];
      if (!sm.has(r.team)) sm.set(r.team, { division: r.division || null, appearances: 0 });
      sm.get(r.team).appearances++;
    }
  }

  // Build output
  const teams = [];
  for (const [teamName, td] of Object.entries(teamData)) {
    const playerList = [];
    for (const [pname, pdata] of td.players.entries()) {
      if (pdata.appearances < minAppearances) continue;
      const currentRating = ratingMap[pname];
      if (currentRating == null) continue;

      const ringerInfo = getRingerInfo(pname, teamName, td.division, playerSeasonTeams);

      playerList.push({
        name: pname,
        rating: Math.round(currentRating),
        appearances: pdata.appearances,
        winRate: pdata.appearances > 0
          ? Math.round(((pdata.wins + 0.5 * pdata.draws) / pdata.appearances) * 100)
          : null,
        ringerInfo: ringerInfo || null,
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
