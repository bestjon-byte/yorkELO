const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const SEASONS = [2018, 2019, 2021, 2022, 2023, 2024, 2025];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const { data: leaderboard, error } = await supabase
    .from('york_players')
    .select('*')
    .order('rank')
    .limit(2000);

  if (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: error.message }));
    return;
  }

  const clubs = [...new Set(leaderboard.map(p => p.club).filter(Boolean))].sort();

  res.end(JSON.stringify({ leaderboard, seasons: SEASONS, clubs }));
};
