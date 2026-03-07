/**
 * Run arbitrary SQL against Supabase via the Management API.
 *
 * Usage:
 *   node scripts/sql.js "SELECT count(*) FROM york_players"
 *   node scripts/sql.js "$(cat query.sql)"
 */
try { require('dotenv').config({ path: '.env.local' }); } catch (_) {}

const https = require('https');

const PROJECT_REF   = 'hwpjrkmplydqaxiikupv';
const ACCESS_TOKEN  = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('Missing SUPABASE_ACCESS_TOKEN in .env.local');
  process.exit(1);
}

function runSQL(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com',
      path:     `/v1/projects/${PROJECT_REF}/database/query`,
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const query = process.argv.slice(2).join(' ');
if (!query) {
  console.log('Usage: node scripts/sql.js "SELECT 1"');
  process.exit(0);
}

runSQL(query).then(({ status, data }) => {
  if (status !== 200 && status !== 201) {
    console.error('Error', status, JSON.stringify(data, null, 2));
    process.exit(1);
  }
  if (Array.isArray(data)) {
    console.table(data);
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}).catch(err => {
  console.error('Request failed:', err.message);
  process.exit(1);
});
