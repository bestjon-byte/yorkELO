/**
 * Validate the computed mens league tables against the official ones at
 * yorkmenstennisleague.co.uk, cell by cell.
 *
 * The official site only publishes the CURRENT season's tables, so this checks
 * the live season. Run it after any change to lib/league-table.js.
 *
 *   node scripts/validate-league-table.js            # all 8 divisions
 *   node scripts/validate-league-table.js 1 2        # just these divisions
 *
 * The mixed league has no equivalent public table to diff against — its rules
 * are encoded from the league rule book instead.
 */

try { require('dotenv').config({ path: '.env.local' }); } catch (_) {}

const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const { buildLeagueTable } = require('../lib/league-table');

const BASE_URL = 'https://www.yorkmenstennisleague.co.uk';
const DIVISIONS = [1, 2, 3, 4, 5, 6, 7, 8];

async function fetchOfficialTable(division) {
  const res = await fetch(`${BASE_URL}/divisions/${division}/Division_${division}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; york-elo-validator)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for division ${division}`);
  const $ = cheerio.load(await res.text());

  const rows = [];
  $('table').first().find('tr').each((_, tr) => {
    const cells = $(tr).find('td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length < 11) return;
    const [pos, teamCell, pld, won, drn, lst, gamesFor, against, , bonus, points] = cells;
    if (!/^\d+$/.test(pos)) return;
    // The team cell renders the name twice (logo alt text + label) and appends
    // one asterisk per fixture the team conceded — "**" for two concessions.
    const penalised = (teamCell.match(/\*/g) || []).length;
    const bare = teamCell.replace(/\*+$/, '').trim();
    const half = bare.slice(0, Math.ceil(bare.length / 2)).trim();
    const team = bare.startsWith(half) && bare.endsWith(half) ? half : bare;
    rows.push({
      position: Number(pos),
      team,
      penalised,
      played: Number(pld),
      won: Number(won),
      drawn: Number(drn),
      lost: Number(lst),
      gamesFor: Number(gamesFor),
      gamesAgainst: Number(against),
      bonus: Number(bonus),
      points: Number(points),
    });
  });
  return rows;
}

const FIELDS = ['played', 'won', 'drawn', 'lost', 'gamesFor', 'gamesAgainst', 'bonus', 'points'];

async function main() {
  const args = process.argv.slice(2).map(Number).filter(n => !Number.isNaN(n));
  const divisions = args.length > 0 ? args : DIVISIONS;

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
  );

  let totalCells = 0;
  let mismatches = 0;

  for (const division of divisions) {
    let official;
    try {
      official = await fetchOfficialTable(division);
    } catch (err) {
      console.log(`Division ${division}: could not fetch official table — ${err.message}`);
      continue;
    }

    const computed = await buildLeagueTable(supabase, { league: 'mens', division });
    const byTeam = new Map(computed.standings.map(t => [t.team, t]));
    const diffs = [];
    const penalised = [];

    if (official.length !== computed.standings.length) {
      diffs.push(`row count: official ${official.length}, computed ${computed.standings.length}`);
    }

    // Compare team by team — a single ordering difference would otherwise
    // report every remaining row as wrong.
    for (const row of official) {
      const c = byTeam.get(row.team);
      if (!c) {
        diffs.push(`team "${row.team}" is in the official table but not in ours`);
        continue;
      }
      if (row.penalised) penalised.push(`${row.team} (${row.penalised} concession${row.penalised > 1 ? 's' : ''})`);
      for (const field of FIELDS) {
        totalCells++;
        if (row[field] !== c[field]) {
          mismatches++;
          diffs.push(`${row.team} ${field}: official ${JSON.stringify(row[field])} vs computed ${JSON.stringify(c[field])}`);
        }
      }
    }

    const officialOrder = official.map(r => r.team).join(' | ');
    const computedOrder = computed.standings.map(r => r.team).join(' | ');
    if (officialOrder !== computedOrder) {
      diffs.push(`order differs:\n       official: ${officialOrder}\n       computed: ${computedOrder}`);
    }

    const note = penalised.length > 0 ? ` (official marks ${penalised.join(', ')} with an admin adjustment)` : '';
    if (diffs.length === 0) {
      console.log(`✅ Division ${division} — ${official.length} teams, exact match (season ${computed.season})${note}`);
    } else {
      console.log(`❌ Division ${division} — ${diffs.length} difference(s)${note}:`);
      for (const d of diffs) console.log(`     ${d}`);
    }
  }

  console.log(`\n${totalCells - mismatches}/${totalCells} cells match.`);
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
