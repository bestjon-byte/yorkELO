const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const name = req.query.name;

  const [historyResult, statsResult] = await Promise.all([
    supabase
      .from('york_match_history')
      .select('*')
      .eq('player_name', name)
      .order('seq')
      .limit(10000),
    supabase
      .from('york_player_stats')
      .select('*')
      .eq('player_name', name)
      .maybeSingle(),
  ]);

  if (historyResult.error || !historyResult.data?.length) {
    res.statusCode = 404;
    res.end('{}');
    return;
  }

  // Map snake_case DB columns to camelCase expected by frontend
  const s = statsResult.data;
  const stats = s ? {
    bestPartner:  s.best_partner,
    worstPartner: s.worst_partner,
    nemesis:      s.nemesis,
    nemesisPair:  s.nemesis_pair,
    nemesisClub:  s.nemesis_club,
    bestClub:     s.best_club,
  } : {};

  res.end(JSON.stringify({ stats, history: historyResult.data }));
};
