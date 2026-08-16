/**
 * Remote MCP server exposing York Tennis ELO data as tools.
 *
 * Connect from any MCP client (Claude, etc.) using this endpoint's URL
 * as a custom/remote connector: https://<deployment>/api/mcp
 *
 * Stateless Streamable HTTP transport — a fresh McpServer + transport is
 * built per request since Vercel serverless functions don't share memory
 * across invocations.
 */

const { createClient } = require('@supabase/supabase-js');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const leagueSchema = z.enum(['mens', 'mixed']).default('mens')
  .describe('Which league: "mens" for the York Men\'s Tennis League, "mixed" for the York & District Mixed Tennis League');

function prefixFor(league) {
  return league === 'mixed' ? 'mixed_' : 'york_';
}

async function fetchAllPlayers(tablePrefix) {
  let rows = [], from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(`${tablePrefix}players`)
      .select('*')
      .order('rank')
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return rows;
}

async function fetchPlayerHistory(tablePrefix, name) {
  const { data, error } = await supabase
    .from(`${tablePrefix}match_history`)
    .select('*')
    .eq('player_name', name)
    .order('seq')
    .limit(10000);
  if (error) throw new Error(error.message);
  return data || [];
}

function summarizeRecord(history) {
  const rec = { wins: 0, losses: 0, draws: 0 };
  for (const h of history) {
    if (h.result === 'W') rec.wins++;
    else if (h.result === 'L') rec.losses++;
    else if (h.result === 'D') rec.draws++;
  }
  const total = rec.wins + rec.losses + rec.draws;
  return { ...rec, total, winRate: total > 0 ? Math.round(((rec.wins + 0.5 * rec.draws) / total) * 100) : null };
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function buildServer() {
  const server = new McpServer(
    { name: 'york-tennis-elo', version: '1.0.0' },
    {
      instructions:
        'Query ELO ratings, rankings, stats, head-to-head records and match history for the ' +
        "York Men's Tennis League and the York & District Mixed Tennis League. Player names " +
        'must match how they appear in the league (use search_players first if unsure).',
    }
  );

  server.registerTool(
    'search_players',
    {
      title: 'Search players',
      description: 'Find players by name (case-insensitive substring match). Returns rating, rank, club and division for each match.',
      inputSchema: {
        query: z.string().min(1).describe('Full or partial player name to search for'),
        league: leagueSchema,
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async ({ query, league, limit }) => {
      const tablePrefix = prefixFor(league);
      const players = await fetchAllPlayers(tablePrefix);
      const q = query.toLowerCase();
      const matches = players
        .filter(p => p.name && p.name.toLowerCase().includes(q))
        .slice(0, limit)
        .map(p => ({
          name: p.name,
          rating: Math.round(p.rating),
          rank: p.rank,
          club: p.club,
          division: p.current_div,
        }));
      if (matches.length === 0) return errorResult(`No players found matching "${query}" in the ${league} league.`);
      return textResult({ league, count: matches.length, players: matches });
    }
  );

  server.registerTool(
    'get_player',
    {
      title: 'Get player profile',
      description: 'Full profile for one player: current rating, rank, club, division, win/loss record, and fun stats (best partner, nemesis, etc). Use search_players first if you are not sure of the exact name.',
      inputSchema: {
        name: z.string().min(1).describe('Exact player name as it appears in the league'),
        league: leagueSchema,
      },
    },
    async ({ name, league }) => {
      const tablePrefix = prefixFor(league);
      const [{ data: playerRow, error: playerErr }, { data: statsRow }, history] = await Promise.all([
        supabase.from(`${tablePrefix}players`).select('*').eq('name', name).maybeSingle(),
        supabase.from(`${tablePrefix}player_stats`).select('*').eq('player_name', name).maybeSingle(),
        fetchPlayerHistory(tablePrefix, name),
      ]);
      if (playerErr) return errorResult(playerErr.message);
      if (!playerRow) return errorResult(`No player found named "${name}" in the ${league} league. Try search_players to find the exact spelling.`);

      const record = summarizeRecord(history);
      const recentMatches = history.slice(-10).reverse().map(h => ({
        date: h.date,
        season: h.season,
        division: h.division,
        team: h.team,
        opponentTeam: h.opp_team,
        partner: h.partner,
        opponents: [h.opp1, h.opp2].filter(Boolean),
        result: h.result,
        score: h.my_games != null && h.opp_games != null ? `${h.my_games}-${h.opp_games}` : null,
        ratingAfter: h.rating != null ? Math.round(h.rating) : null,
      }));

      return textResult({
        league,
        name: playerRow.name,
        rating: Math.round(playerRow.rating),
        rank: playerRow.rank,
        club: playerRow.club,
        currentDivision: playerRow.current_div,
        firstDivision: playerRow.first_div,
        rubbersPlayed: playerRow.rubbers_played,
        lastPlayed: playerRow.last_played,
        record,
        bestPartner: statsRow?.best_partner || null,
        worstPartner: statsRow?.worst_partner || null,
        nemesis: statsRow?.nemesis || null,
        nemesisPair: statsRow?.nemesis_pair || null,
        nemesisClub: statsRow?.nemesis_club || null,
        bestClub: statsRow?.best_club || null,
        recentMatches,
      });
    }
  );

  server.registerTool(
    'get_leaderboard',
    {
      title: 'Get leaderboard',
      description: 'Top-rated players, optionally filtered by division or club.',
      inputSchema: {
        league: leagueSchema,
        division: z.number().int().min(1).max(10).optional().describe('Filter to a current division (1 = top division)'),
        club: z.string().optional().describe('Filter to players whose club name contains this (case-insensitive)'),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ league, division, club, limit }) => {
      const tablePrefix = prefixFor(league);
      let players = await fetchAllPlayers(tablePrefix);
      if (division != null) players = players.filter(p => p.current_div === division);
      if (club) {
        const c = club.toLowerCase();
        players = players.filter(p => p.club && p.club.toLowerCase().includes(c));
      }
      const top = players.slice(0, limit).map(p => ({
        rank: p.rank,
        name: p.name,
        rating: Math.round(p.rating),
        club: p.club,
        division: p.current_div,
      }));
      return textResult({ league, division: division ?? 'all', club: club ?? 'all', count: top.length, leaderboard: top });
    }
  );

  server.registerTool(
    'get_match_history',
    {
      title: 'Get match history',
      description: "A player's individual rubber-by-rubber match history, most recent first.",
      inputSchema: {
        name: z.string().min(1).describe('Exact player name as it appears in the league'),
        league: leagueSchema,
        season: z.number().int().optional().describe('Filter to a single season, e.g. 2025'),
        limit: z.number().int().min(1).max(200).default(25),
      },
    },
    async ({ name, league, season, limit }) => {
      const tablePrefix = prefixFor(league);
      let history = await fetchPlayerHistory(tablePrefix, name);
      if (history.length === 0) return errorResult(`No match history found for "${name}" in the ${league} league.`);
      if (season != null) history = history.filter(h => h.season === season);
      const matches = history.slice(-limit).reverse().map(h => ({
        date: h.date,
        season: h.season,
        division: h.division,
        team: h.team,
        opponentTeam: h.opp_team,
        partner: h.partner,
        opponents: [h.opp1, h.opp2].filter(Boolean),
        result: h.result,
        score: h.my_games != null && h.opp_games != null ? `${h.my_games}-${h.opp_games}` : null,
        ratingAfter: h.rating != null ? Math.round(h.rating) : null,
      }));
      return textResult({ league, name, season: season ?? 'all', count: matches.length, matches });
    }
  );

  server.registerTool(
    'compare_players',
    {
      title: 'Compare two players',
      description: 'ELO-based win probability between two players, plus their actual head-to-head and partnership record if they have played each other or partnered together.',
      inputSchema: {
        player1: z.string().min(1),
        player2: z.string().min(1),
        league: leagueSchema,
      },
    },
    async ({ player1, player2, league }) => {
      const tablePrefix = prefixFor(league);
      const [{ data: p1 }, { data: p2 }, history1] = await Promise.all([
        supabase.from(`${tablePrefix}players`).select('*').eq('name', player1).maybeSingle(),
        supabase.from(`${tablePrefix}players`).select('*').eq('name', player2).maybeSingle(),
        fetchPlayerHistory(tablePrefix, player1),
      ]);
      if (!p1) return errorResult(`No player found named "${player1}" in the ${league} league.`);
      if (!p2) return errorResult(`No player found named "${player2}" in the ${league} league.`);

      const expected1 = 1 / (1 + Math.pow(10, (p2.rating - p1.rating) / 400));

      const asOpponents = history1.filter(h => h.opp1 === player2 || h.opp2 === player2);
      const asPartners = history1.filter(h => h.partner === player2);
      const oppRecord = summarizeRecord(asOpponents);

      return textResult({
        league,
        player1: { name: p1.name, rating: Math.round(p1.rating), rank: p1.rank },
        player2: { name: p2.name, rating: Math.round(p2.rating), rank: p2.rank },
        eloWinProbability: {
          [player1]: Math.round(expected1 * 100) / 100,
          [player2]: Math.round((1 - expected1) * 100) / 100,
        },
        headToHead: {
          rubbersPlayedAgainstEachOther: asOpponents.length,
          record: `${oppRecord.wins}W-${oppRecord.losses}L-${oppRecord.draws}D (from ${player1}'s perspective)`,
        },
        partnership: {
          rubbersPlayedTogether: asPartners.length,
          record: asPartners.length > 0 ? summarizeRecord(asPartners) : null,
        },
      });
    }
  );

  server.registerTool(
    'list_clubs',
    {
      title: 'List clubs',
      description: 'All club names currently in the league, for use as a filter with get_leaderboard.',
      inputSchema: { league: leagueSchema },
    },
    async ({ league }) => {
      const tablePrefix = prefixFor(league);
      const players = await fetchAllPlayers(tablePrefix);
      const clubs = [...new Set(players.map(p => p.club).filter(Boolean))].sort();
      return textResult({ league, count: clubs.length, clubs });
    }
  );

  return server;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
  }
};
