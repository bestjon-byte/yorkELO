/**
 * Detects players who share the same name but are provably different people
 * (same-date, different-fixture clashes). Builds a conflict graph at the club
 * level, then uses greedy graph colouring (Welsh-Powell) to partition clubs
 * into "people". Outputs a player-splits.json.
 *
 * Usage:
 *   node scripts/detect-name-conflicts.js           — print report
 *   node scripts/detect-name-conflicts.js --write   — write player-splits.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const aliases = JSON.parse(fs.readFileSync(path.join(ROOT, 'player-aliases.json')));
function resolve(n) {
  let x = n;
  const visited = new Set();
  while (aliases[x] && !visited.has(x)) { visited.add(x); x = aliases[x]; }
  return x;
}
// Strip trailing team number: "Starbeck 1" → "Starbeck", "David Lloyd York 3" → "David Lloyd York"
function clubOf(team) { return team.replace(/\s+\d+$/, '').trim(); }

// --- Load all fixtures ---
const files = fs.readdirSync(ROOT).filter(f => /^fixtures_\d{4}\.json$/.test(f)).sort();
const allFixtures = [];
for (const f of files) allFixtures.push(...JSON.parse(fs.readFileSync(path.join(ROOT, f))).fixtures);

// Build per-resolved-name: date → { club → Set<fixtureId> }
const nameData = {};
for (const fix of allFixtures) {
  if (!fix.date || !fix.fixture_id) continue;
  const fid = String(fix.fixture_id);
  const addP = (rawName, team) => {
    if (!rawName) return;
    const name = resolve(rawName);
    const club = clubOf(team);
    if (!nameData[name]) nameData[name] = {};
    if (!nameData[name][fix.date]) nameData[name][fix.date] = {};
    if (!nameData[name][fix.date][club]) nameData[name][fix.date][club] = new Set();
    nameData[name][fix.date][club].add(fid);
  };
  for (const r of (fix.rubbers || [])) {
    addP(r.home_player1, fix.home_team); addP(r.home_player2, fix.home_team);
    addP(r.away_player1, fix.away_team); addP(r.away_player2, fix.away_team);
  }
}

// --- Build club-level conflict graph for a given name ---
function buildConflictGraph(dateMap) {
  const allClubs = new Set();
  const conflicts = new Set(); // "clubA|||clubB" sorted pairs

  for (const clubFids of Object.values(dateMap)) {
    const clubList = Object.keys(clubFids);
    for (const c of clubList) allClubs.add(c);
    for (let i = 0; i < clubList.length; i++) {
      for (let j = i + 1; j < clubList.length; j++) {
        const a = clubList[i], b = clubList[j];
        const fidsA = clubFids[a], fidsB = clubFids[b];
        // Conflict = each club has a fixture the other doesn't (different fixtures same date)
        const aNotB = [...fidsA].some(id => !fidsB.has(id));
        const bNotA = [...fidsB].some(id => !fidsA.has(id));
        if (aNotB || bNotA) conflicts.add([a, b].sort().join('|||'));
      }
    }
  }
  return { clubs: [...allClubs], conflicts };
}

// --- Welsh-Powell greedy graph colouring ---
// Returns array of groups (each group = Set<club>); clubs in same group are "same person"
function colourGraph(clubs, conflicts) {
  const conflictsOf = {};
  for (const c of clubs) conflictsOf[c] = new Set();
  for (const pair of conflicts) {
    const [a, b] = pair.split('|||');
    conflictsOf[a].add(b);
    conflictsOf[b].add(a);
  }

  // Sort by degree descending (Welsh-Powell)
  const sorted = [...clubs].sort((a, b) => conflictsOf[b].size - conflictsOf[a].size);

  const groups = []; // Array of Set<club>
  const assigned = {};

  for (const club of sorted) {
    if (assigned[club] !== undefined) continue;
    // Start a new group with this club
    const group = new Set([club]);
    assigned[club] = groups.length;

    // Add any unassigned clubs that don't conflict with any member of this group
    for (const other of sorted) {
      if (assigned[other] !== undefined) continue;
      const canJoin = [...group].every(m => !conflictsOf[other].has(m));
      if (canJoin) {
        group.add(other);
        assigned[other] = groups.length;
      }
    }
    groups.push(group);
  }
  return groups;
}

// Count fixtures per club for a name
function fixtureCounts(dateMap) {
  const counts = {};
  for (const clubFids of Object.values(dateMap)) {
    for (const [club, fids] of Object.entries(clubFids)) {
      counts[club] = (counts[club] || 0) + fids.size;
    }
  }
  return counts;
}

// --- Build splits ---
const splits = {};
const report = [];

for (const [name, dateMap] of Object.entries(nameData)) {
  const { clubs, conflicts } = buildConflictGraph(dateMap);
  if (clubs.length <= 1 || conflicts.size === 0) continue;

  const groups = colourGraph(clubs, conflicts);
  if (groups.length <= 1) continue;

  const counts = fixtureCounts(dateMap);

  // Sort groups by total fixture count desc; largest keeps original name
  const groupsWithCount = groups.map(g => ({
    clubs: [...g].sort(),
    total: [...g].reduce((s, c) => s + (counts[c] || 0), 0),
  })).sort((a, b) => b.total - a.total);

  const splitDefs = groupsWithCount.map((g, idx) => ({
    label: idx === 0 ? name : name + ' (' + g.clubs[0] + ')',
    clubs: g.clubs,
    fixtureCount: g.total,
  }));

  splits[name] = splitDefs;
  report.push({ name, clusters: splitDefs });
}

// --- Report ---
console.log(report.length + ' name(s) need splitting:\n');
for (const { name, clusters } of report) {
  console.log('  ' + name + ':');
  for (const c of clusters) {
    console.log('    "' + c.label + '" — clubs: [' + c.clubs.join(', ') + '] (' + c.fixtureCount + ' fixtures)');
  }
}

// --- Write ---
if (process.argv.includes('--write')) {
  const out = {};
  for (const [name, defs] of Object.entries(splits)) {
    out[name] = defs.map(d => ({ label: d.label, clubs: d.clubs }));
  }
  fs.writeFileSync(path.join(ROOT, 'player-splits.json'), JSON.stringify(out, null, 2));
  console.log('\nWrote player-splits.json');
}
