const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Paginate to get all players past Supabase's default 1000-row cap
  let leaderboard = [], from = 0, fetchError = null;
  while (true) {
    const { data, error } = await supabase
      .from('york_players')
      .select('*')
      .order('rank')
      .range(from, from + 999);
    if (error) { fetchError = error; break; }
    leaderboard.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }

  if (fetchError) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: fetchError.message }));
    return;
  }

  const clubs = [...new Set(leaderboard.map(p => p.club).filter(Boolean))].sort();

  res.end(JSON.stringify({ leaderboard, seasons: SEASONS, clubs }));
};
