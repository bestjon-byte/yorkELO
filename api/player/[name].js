const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const name = req.query.name;
  const isMixed = req.query.league === 'mixed';
  const tablePrefix = isMixed ? 'mixed_' : 'york_';

  const [historyResult, statsResult] = await Promise.all([
    supabase
      .from(`${tablePrefix}match_history`)
      .select('*')
      .eq('player_name', name)
      .order('seq')
      .limit(10000),
    supabase
      .from(`${tablePrefix}player_stats`)
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
    nemesis_pair:  s.nemesis_pair,
    nemesis_club:  s.nemesis_club,
    best_club:     s.best_club,
  } : {};

  res.end(JSON.stringify({ stats, history: historyResult.data }));
};
