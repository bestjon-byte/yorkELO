const { createClient } = require('@supabase/supabase-js');

function parseDate(str) {
  return str ? new Date(str) : null;
}

function extractDivision(teamName) {
  const m = teamName && teamName.match(/\s(\d+)$/);
  return m ? parseInt(m[1]) : null;
}

async function fetchAllRows(supabase, table, columns, filters = {}) {
  let rows = [], from = 0;
  while (true) {
    let q = supabase.from(table).select(columns).range(from, from + 999);
    for (const [col, val] of Object.entries(filters)) q = q.gte(col, val);
    const { data, error } = await q;
    if (error) return { rows: null, error };
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return { rows, error: null };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Support both Vercel (req.query) and plain Node HTTP (parse URL ourselves)
  const query = req.query || Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  const months = Math.min(Math.max(parseInt(query.months) || 12, 1), 60);
  const minAppearances = Math.min(Math.max(parseInt(query.minAppearances) || 3, 1), 100);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  // Only fetch seasons that could overlap with the lookback window.
  // Seasons run ~Apr-Sep, so season Y ends around Sep Y.
  // For a cutoff of e.g. Mar 2025, season 2024 (ending Sep 2024) is within range.
  const cutoffYear = cutoff.getFullYear() - 1; // be generous: include one extra year

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Fetch match history for relevant seasons (include division so we use real league division, not team suffix)
  const { rows: historyRows, error: histErr } = await fetchAllRows(
    supabase,
    'york_match_history',
    'player_name, team, date, season, result, division',
    { season: cutoffYear }
  );
  if (histErr) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: histErr.message }));
    return;
  }

  // Fetch current player ratings
  const { rows: playerRows, error: playerErr } = await fetchAllRows(
    supabase,
    'york_players',
    'name, rating'
  );
  if (playerErr) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: playerErr.message }));
    return;
  }

  const ratingMap = {};
  for (const p of playerRows) ratingMap[p.name] = p.rating;

  // Filter history to exact date window
  const filtered = historyRows.filter(r => {
    const d = parseDate(r.date);
    return d && d >= cutoff;
  });

  // Aggregate by team
  const teamData = {};
  for (const r of filtered) {
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
    months,
    minAppearances,
    cutoffDate: cutoff.toISOString().split('T')[0],
    teamCount: teams.length,
  }));
};
