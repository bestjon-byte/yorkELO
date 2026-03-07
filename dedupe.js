/**
 * Interactive player deduplication tool.
 *
 * Scans all fixtures_*.json and walks you through two phases:
 *
 * Phase 1 — Same team, similar name (high confidence typos)
 *   e.g. "Jon Best" vs "John Best" at Cawood 2
 *
 * Phase 2 — Different teams, same or similar name (possible club move)
 *   e.g. "Ben Walker" at Cawood 1 AND Wigginton 1
 *
 * Each candidate pair asks:
 *
 *   y  — merge (keeps the more common spelling as canonical)
 *   n  — different people, not a duplicate
 *   c  — merge but I'll type the canonical name myself
 *   s  — skip for now (won't be remembered)
 *   q  — quit and save progress
 *
 * Confirmed merges are written to player-aliases.json.
 * Confirmed "not duplicates" are written to player-not-dupes.json so they
 * won't be shown again.
 *
 * Usage:
 *   node dedupe.js          — interactive review
 *   node dedupe.js --report — print report only, no interaction
 */

const fs = require('fs');
const readline = require('readline');

const ALIASES_FILE = 'player-aliases.json';
const NOT_DUPES_FILE = 'player-not-dupes.json';
const MAX_DIST = 2;

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Load data
// ---------------------------------------------------------------------------
function loadAllFixtures() {
  const files = fs.readdirSync('.').filter(f => /^fixtures_\d{4}\.json$/.test(f)).sort();
  if (!files.length) { console.error('No fixtures_*.json files found.'); process.exit(1); }
  const all = [];
  for (const f of files) all.push(...JSON.parse(fs.readFileSync(f)).fixtures);
  console.log(`Loaded fixtures from: ${files.join(', ')}`);
  return all;
}

function loadJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ---------------------------------------------------------------------------
// Build team → players map, tracking appearance count and seasons per player
// ---------------------------------------------------------------------------
function buildTeamPlayers(fixtures) {
  // teamPlayers[team][name] = { count, years: Set }
  const teamPlayers = {};
  for (const f of fixtures) {
    const year = f.season;
    for (const r of f.rubbers) {
      const add = (team, name) => {
        if (!name) return;
        if (!teamPlayers[team]) teamPlayers[team] = {};
        if (!teamPlayers[team][name]) teamPlayers[team][name] = { count: 0, years: new Set() };
        teamPlayers[team][name].count++;
        teamPlayers[team][name].years.add(year);
      };
      add(f.home_team, r.home_player1); add(f.home_team, r.home_player2);
      add(f.away_team, r.away_player1); add(f.away_team, r.away_player2);
    }
  }
  return teamPlayers;
}

function yearRange(years) {
  const sorted = [...years].sort();
  if (sorted.length === 1) return `${sorted[0]}`;
  if (sorted[sorted.length - 1] - sorted[0] === sorted.length - 1) {
    return `${sorted[0]}–${sorted[sorted.length - 1]}`; // contiguous range
  }
  return sorted.join(', '); // non-contiguous
}

// ---------------------------------------------------------------------------
// Find candidates — Phase 1 (same team) and Phase 2 (cross-team)
// ---------------------------------------------------------------------------
function findCandidates(teamPlayers, aliases, notDupes) {
  const resolve = name => aliases[name] || name;
  const alreadyResolved = (a, b) => resolve(a) === resolve(b);
  const isNotDupe = (a, b) => notDupes[[a, b].sort().join('|||')];

  const phase1 = []; // same team, similar name
  const phase2 = []; // different teams, exact or similar name

  // Phase 1: same team, edit distance <= MAX_DIST
  for (const [team, players] of Object.entries(teamPlayers)) {
    const names = Object.keys(players).sort();
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const a = names[i], b = names[j];
        if (alreadyResolved(a, b) || isNotDupe(a, b)) continue;
        const dist = levenshtein(a, b);
        if (dist <= MAX_DIST) {
          phase1.push({ phase: 1, team, teams: [team], name1: a, count1: players[a].count, name2: b, count2: players[b].count, distance: dist });
        }
      }
    }
  }

  // Phase 2: different teams, edit distance <= 1 (exact or one-char diff)
  // Build global name → [{team, count, years}] map
  const nameIndex = {};
  for (const [team, players] of Object.entries(teamPlayers)) {
    for (const [name, { count, years }] of Object.entries(players)) {
      if (!nameIndex[name]) nameIndex[name] = [];
      nameIndex[name].push({ team, count, years });
    }
  }

  const allNames = Object.keys(nameIndex).sort();
  const seenPairs = new Set();

  for (let i = 0; i < allNames.length; i++) {
    for (let j = i + 1; j < allNames.length; j++) {
      const a = allNames[i], b = allNames[j];
      if (alreadyResolved(a, b) || isNotDupe(a, b)) continue;

      // Only cross-team pairs
      const teamsA = new Set(nameIndex[a].map(x => x.team));
      const teamsB = new Set(nameIndex[b].map(x => x.team));
      const sharedTeams = [...teamsA].filter(t => teamsB.has(t));
      if (sharedTeams.length > 0) continue; // already covered by phase 1

      const dist = levenshtein(a, b);
      if (dist > 1) continue; // stricter threshold for cross-team

      const pairKey = [a, b].sort().join('|||');
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const countA = nameIndex[a].reduce((s, x) => s + x.count, 0);
      const countB = nameIndex[b].reduce((s, x) => s + x.count, 0);

      // Merge all years across all teams for each name
      const yearsA = new Set(nameIndex[a].flatMap(x => [...x.years]));
      const yearsB = new Set(nameIndex[b].flatMap(x => [...x.years]));
      const overlap = [...yearsA].filter(y => yearsB.has(y));

      phase2.push({
        phase: 2,
        teams: [...new Set([...nameIndex[a].map(x => x.team), ...nameIndex[b].map(x => x.team)])],
        name1: a, count1: countA,
        teams1: nameIndex[a].map(x => `${x.team} (${x.count}, ${yearRange(x.years)})`),
        yearsA, overlapYears: overlap,
        name2: b, count2: countB,
        teams2: nameIndex[b].map(x => `${x.team} (${x.count}, ${yearRange(x.years)})`),
        yearsB,
        distance: dist,
      });
    }
  }

  phase1.sort((a, b) => a.distance - b.distance || a.team.localeCompare(b.team));
  phase2.sort((a, b) => a.distance - b.distance || a.name1.localeCompare(b.name1));

  return { phase1, phase2 };
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------
function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function reviewBatch(label, candidates, total, offset, rl, aliases, notDupes) {
  let reviewed = 0;
  for (const c of candidates) {
    const idx = offset + reviewed + 1;
    const defaultCanonical = c.count1 >= c.count2 ? c.name1 : c.name2;
    const minority = defaultCanonical === c.name1 ? c.name2 : c.name1;

    console.log(`\n[${idx}/${total}] ${label}  (edit distance: ${c.distance})`);
    if (c.phase === 1) {
      console.log(`  Team: ${c.team}`);
      console.log(`  A: "${c.name1}"  (${c.count1} rubbers)`);
      console.log(`  B: "${c.name2}"  (${c.count2} rubbers)`);
    } else {
      console.log(`  A: "${c.name1}"  — ${c.teams1.join(', ')}`);
      console.log(`  B: "${c.name2}"  — ${c.teams2.join(', ')}`);
      if (c.overlapYears.length > 0) {
        console.log(`  ⚠ Played same year(s): ${c.overlapYears.sort().join(', ')} — likely different people`);
      } else {
        console.log(`  ✓ No year overlap (${yearRange(c.yearsA)} vs ${yearRange(c.yearsB)}) — possible club move`);
      }
    }
    console.log(`  → default canonical: "${defaultCanonical}"`);

    const answer = (await prompt(rl, '  y/n/c/s/q ? ')).trim().toLowerCase();

    if (answer === 'q') { return { reviewed, quit: true }; }
    else if (answer === 'y') {
      aliases[minority] = defaultCanonical;
      console.log(`  ✓ "${minority}" → "${defaultCanonical}"`);
    } else if (answer === 'c') {
      const custom = (await prompt(rl, '  Canonical name: ')).trim();
      if (custom) {
        if (c.name1 !== custom) aliases[c.name1] = custom;
        if (c.name2 !== custom) aliases[c.name2] = custom;
        console.log(`  ✓ Both aliased to "${custom}"`);
      }
    } else if (answer === 'n') {
      notDupes[[c.name1, c.name2].sort().join('|||')] = true;
      console.log(`  ✗ Different people`);
    } else {
      console.log(`  → Skipped`);
    }

    saveJson(ALIASES_FILE, aliases);
    saveJson(NOT_DUPES_FILE, notDupes);
    reviewed++;
  }
  return { reviewed, quit: false };
}

async function interactiveReview(phase1, phase2, aliases, notDupes) {
  const total = phase1.length + phase2.length;
  if (total === 0) { console.log('\nNo pending candidates — all resolved!\n'); return; }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\n${total} pairs to review: ${phase1.length} same-team, ${phase2.length} cross-team`);
  console.log('y=merge  n=different people  c=custom name  s=skip  q=quit\n');

  if (phase1.length > 0) {
    console.log('━━━ Phase 1: Same team, similar name (likely typos) ━━━');
    const { quit } = await reviewBatch('same-team', phase1, total, 0, rl, aliases, notDupes);
    if (quit) { rl.close(); return; }
  }

  if (phase2.length > 0) {
    console.log('\n━━━ Phase 2: Different teams, same/similar name (club move?) ━━━');
    await reviewBatch('cross-team', phase2, total, phase1.length, rl, aliases, notDupes);
  }

  rl.close();
  console.log(`\nDone. ${Object.keys(aliases).length} aliases saved to ${ALIASES_FILE}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const reportOnly = process.argv.includes('--report');
  const fixtures = loadAllFixtures();
  const aliases = loadJson(ALIASES_FILE);
  const notDupes = loadJson(NOT_DUPES_FILE);
  const teamPlayers = buildTeamPlayers(fixtures);
  const { phase1, phase2 } = findCandidates(teamPlayers, aliases, notDupes);

  console.log(`\nFound ${phase1.length} same-team + ${phase2.length} cross-team candidates\n`);

  if (reportOnly) {
    console.log('━━━ Phase 1: Same team ━━━');
    let currentTeam = null;
    for (const c of phase1) {
      if (c.team !== currentTeam) {
        if (currentTeam) console.log();
        console.log(`Team: ${c.team}`);
        currentTeam = c.team;
      }
      console.log(`  [d=${c.distance}] "${c.name1}" (${c.count1}) vs "${c.name2}" (${c.count2})`);
    }
    console.log('\n━━━ Phase 2: Cross-team ━━━');
    for (const c of phase2) {
      const overlap = c.overlapYears.length > 0
        ? `⚠ overlap: ${c.overlapYears.sort().join(', ')}`
        : `✓ no overlap (${yearRange(c.yearsA)} vs ${yearRange(c.yearsB)})`;
      console.log(`  [d=${c.distance}] "${c.name1}" [${c.teams1.join(', ')}]`);
      console.log(`         vs "${c.name2}" [${c.teams2.join(', ')}]`);
      console.log(`         ${overlap}`);
    }
    return;
  }

  await interactiveReview(phase1, phase2, aliases, notDupes);
}

main().catch(err => { console.error(err); process.exit(1); });
