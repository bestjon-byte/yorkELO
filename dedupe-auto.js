/**
 * Pre-applies all high-confidence deduplication decisions.
 * Run this once, then run `node dedupe.js` to handle the remaining uncertain cases.
 */

const fs = require('fs');

const ALIASES_FILE = 'player-aliases.json';
const NOT_DUPES_FILE = 'player-not-dupes.json';

// ---------------------------------------------------------------------------
// Confirmed aliases: variant → canonical
// Rules: canonical = more common spelling, OR correct spelling if obvious typo
// ---------------------------------------------------------------------------
const CONFIRMED_ALIASES = {
  // Case-only differences (d=0)
  "Andy clarke": "Andy Clarke",
  "Marcus hewlett": "Marcus Hewlett",
  "Chris partridge": "Chris Partridge",
  "Mark pearce": "Mark Pearce",
  "Warren broadbent": "Warren Broadbent",
  "James van der Merwe": "James Van Der Merwe",
  "Jack hoar": "Jack Hoare",
  "Gabe mead": "Gabe Meade",
  "Luke beilby": "Luke Bielby",
  "Stu enyon": "Stu Eynon",
  "Dave gamble": "Dave Gamble",
  "Michael Mcglynn": "Michael McGlynn",
  "Wick craggs": "Nick Craggs",  // clear N→W typo

  // Same team, d=1 — obvious typos
  "Tom Holiday": "Tom Holliday",
  "Craig hurst": "Craig Hirst",
  "Danny Grannon": "Danny Gannon",        // extra r (3 vs 96)
  "Jesse Cooke": "Jesse Cook",            // 33 vs 57 total
  "Jos Morrisey": "Jos Morrissey",
  "Math Saxon": "Matt Saxon",             // 3 vs 33
  "Nathan Cooke": "Nathan Cook",          // 3 vs 63
  "Jon Longthorpe": "Jon Longthorp",      // 27 vs 117
  "Tristan Pemberton": "Trystan Pemberton", // 12 vs 72
  "Jon Best": "John Best",               // 18 vs 51
  "Steven Walter": "Steve Walter",        // 39 vs 54
  "Mark Coombes": "Mark Coombs",          // 36 vs 117
  "Matt McErlene": "Matt McErlane",       // 30 vs 45
  "Jack Gibbens": "Jack Gibbons",         // 9 vs 18
  "Mathew Walke": "Matthew Walke",        // 30 vs 48
  "Matt Ralphs": "Matt Ralph",            // 6 vs 21
  "Nathan Elliot": "Nathan Elliott",      // 24 vs 33 total
  "Seb Brandom": "Sebi Brandom",          // 3 vs 18
  "Conor Firth": "Connor Firth",          // 3 vs 27
  "Ray Lockie": "Ray Locke",              // 30 vs 75
  "Howard Widdell": "Howard Widdall",     // 36 vs 99 total
  "Matthew Machine": "Matthew Machin",    // clear typo
  "Alex Ngyuyen": "Alex Nguyen",          // transposed letters (correct spelling override)
  "Elie Vosel": "Elie Vogel",             // 3 vs 6
  "Colin Leflen": "Colin Lefley",         // 3 vs 27
  "Gabriel Bortes": "Gabriel Bortas",     // 36 vs 66
  "Christon Dillow": "Christon Dillon",   // 12 vs 30
  "Keigan Freeman Hacker": "Keigan Freeman-Hacker", // missing hyphen (correct form)
  "Bence Duhai": "Bence Dulai",           // 3 vs 12
  "Gareth Doey": "Gareth Doeg",           // 9 vs 27 total
  "Ollie Dundass": "Ollie Dundas",        // 6 vs 33
  "Ollie Dunder": "Ollie Dundas",         // clear typo
  "Mark Hinchliffe": "Mark Hinchcliffe",  // 6 vs 36
  "Owain Rowatt": "Owain Rowat",          // 18 vs 78
  "David Hurran": "David Hurren",         // 9 vs 78
  "Willow Colios": "Willow Colias",       // 9 vs 24
  "Damian Pease": "Damien Pease",         // 6 vs 9
  "Martin Shard": "Martin Sheard",        // equal counts, Sheard is correct Yorkshire surname
  "Peter Gray": "Peter Grey",             // 57 vs 105
  "Samson Sharratt": "Samson Sharrat",    // 66 vs 96 total
  "Steve Langron": "Steve Langton",       // 9 vs 12
  "Tim Rawling": "Tim Rawlins",           // 3 vs 45
  "Sam Tennent": "Sam Tennant",           // 15 vs 27
  "Damian Galloway": "Damien Galloway",   // 6 vs 114
  "Jonno Scutt": "Jono Scutt",            // 6 vs 21
  "Stuart Pauer": "Stuart Paver",         // 60 vs 69
  "Frazer Cummings": "Fraser Cummings",   // equal counts, Fraser is standard spelling
  "Ollie Steel": "Ollie Steele",          // 24 vs 27 total
  "Nick O'Keefe": "Nick O'Keeffe",        // 33 vs 105
  "Kieron Screeton": "Kieran Screeton",   // 30 vs 87
  "Jonathan Sanders": "Jonathan Saunders", // 3 vs 15
  "David Lloyd Moliner": "David Lloyd-Moliner", // 15 vs 27 total, missing hyphen
  "Malik Murison": "Malek Murison",       // 24 vs 63 total
  "Charles Rice": "Charlie Rice",         // 12 vs 45
  "Luke Travence": "Luke Travena",        // 6 vs 9
  "Dave Morritt": "David Morritt",        // 12 vs 27
  "Chris Knowles": "Kris Knowles",        // 9 vs 51 total
  "Martin Ladier": "Martin Laidler",      // 12 vs 84
  "Dartel Norman": "Daryl Norman",        // correct spelling
  "Alex Patient": "Alex Patience",        // 45 vs 51
  "Mick Abel": "Mike Abel",               // 15 vs 114
  "Nils Morosz": "Nils Morozs",           // 12 vs 84 total
  "Joshua Balog": "Josh Balog",           // 3 vs 33
  "Chris Robsjons": "Chris Robjohns",     // 42 vs 54 total
  "Indiana Cafney": "Indiana Caffrey",    // 18 vs 21
  "Jack Adderson": "Jack Addison",        // correct spelling
  "Oli Scott": "Ollie Scott",             // 6 vs 15
  "Felipe Brescancini": "Felipe Brescangni", // 18 vs 48
  "Anthony Tompkins": "Anthony Tomkins",  // 30 vs 78 total
  "Graham Garbutt": "Graham Garbut",      // 3 vs 60

  // Cross-team (Phase 2) — clear typos across clubs
  "Anish Jovar": "Anish Johar",           // 6 vs 51 (also Rohan below)
  "Ben Orten": "Ben Orton",               // 39 vs 144
  "Bence Oulai": "Bence Dulai",           // 3 vs 93 total
  "Evan Henley Jones": "Evan Henley-Jones", // missing hyphen, same family Dunnington teams
  "Gabriel Olteans": "Gabriel Olteanu",   // 12 vs 18
  "Jasper Jacobs": "Jasper Jacob",        // 3 vs 9
  "Jonathan Kidd": "Jonathan Kydd",       // 3 vs 18
  "Rob Proudley": "Rob Prowdley",         // 3 vs 66
  "Rohan Jovar": "Rohan Johar",           // 9 vs 27 (same surname typo as Anish)
  "RomanFoster": "Roman Foster",          // missing space
  "Mike Triffit": "Mike Triffitt",        // 3 vs 93 total
  "Nick Clemishaw": "Nick Clemshaw",      // 39 vs 168
  "Lindsey Edgar": "Lindsay Edgar",       // 6 vs 9
  "Matt Lowe": "Mat Lowe",               // Matt=Mat, Selby 1 & 2 same club (36 vs 3)

  // Phase 1 remaining — Bob=Rob (Robert) nicknames, nickname/spelling variants
  "Rob Coggrave": "Rob Cograve",          // same team, Cograve=18 more common
  "Bob Douglas": "Rob Douglas",           // Bob=Rob, same team Rowntree Park 3
  "Bob Scrase": "Rob Scrase",             // Bob=Rob, same team Rowntree Park 3
  "Anthony Beatties": "Antony Beattie",   // extra 's' typo, same team
  "Carlos Horner": "Carlos Homer",        // extra 'r' typo, same team (Homer=15)
  "Harris Calvert": "Harrison Calvert",   // Harris=short for Harrison, same team
  "Dave Russell": "David Russell",        // Dave=David, same Rowntree Park teams
  "Dave Stuart": "Dave Stewart",          // Stuart/Stewart variant, same team
  "Peter Clark": "Peter Clarke",          // Clark/Clarke variant, Clarke=15 more common
};

// ---------------------------------------------------------------------------
// Confirmed not-dupes: definitely different people
// ---------------------------------------------------------------------------
const CONFIRMED_NOT_DUPES = [
  ["Dave Hall Jr", "Dave Hall Sr"],         // father & son — explicitly named
  ["Charlie Price", "Charlie Rice"],        // Price ≠ Rice, different clubs
  ["Steve Walker", "Steve Walter"],         // Walker ≠ Walter, different clubs
  ["David Bean", "David Whan"],             // Bean ≠ Whan, totally different
  ["Name withheld", "Name withheld 2"],     // anonymous different players
  ["Cam Campbell", "Ian Campbell"],         // Cam ≠ Ian, d=2
  ["Luke Kay", "Mike Kay"],                 // Luke ≠ Mike
  ["Tom Baker", "Tom Barker"],              // Baker ≠ Barker, different clubs
  ["Mark Dawson", "Mark Lawson"],           // D vs L, completely different surnames
  ["Bob Shread", "Dom Shread"],             // Bob ≠ Dom, very different names
  // Phase 2 cross-team — year overlap confirms different people playing simultaneously
  ["Jonny Kay", "Jonny Kaye"],              // overlap every year 2018–2024
  ["Andy Cossins", "Andy Cousins"],         // overlap 2018–2019
  ["David Moore", "David Moores"],          // overlap 2018–2019, different clubs
  ["Nick Boid", "Nick Boyd"],               // overlap 2018; 240 rubbers of consistent "Boid" spelling
  ["Steve Jones", "Steven Jones"],          // overlap 2018 & 2021; very common name, different clubs
  ["Andy Boulton", "Andy Poulton"],         // overlap 2024
  ["Mark Bland", "Mark Blane"],             // overlap 2018, different clubs
];

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
function loadJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
}

function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const aliases = loadJson(ALIASES_FILE);
const notDupes = loadJson(NOT_DUPES_FILE);

let aliasAdded = 0;
for (const [variant, canonical] of Object.entries(CONFIRMED_ALIASES)) {
  if (!aliases[variant]) {
    aliases[variant] = canonical;
    aliasAdded++;
  }
}

let notDupeAdded = 0;
for (const [a, b] of CONFIRMED_NOT_DUPES) {
  const key = [a, b].sort().join('|||');
  if (!notDupes[key]) {
    notDupes[key] = true;
    notDupeAdded++;
  }
}

saveJson(ALIASES_FILE, aliases);
saveJson(NOT_DUPES_FILE, notDupes);

console.log(`Added ${aliasAdded} aliases (${Object.keys(aliases).length} total)`);
console.log(`Added ${notDupeAdded} not-dupe pairs (${Object.keys(notDupes).length} total)`);
console.log('\nRun `node dedupe.js --report` to see remaining uncertain cases.');
