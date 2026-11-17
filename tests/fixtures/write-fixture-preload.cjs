// Verification-only preload passed by the test harness, never by production.
// Change this child's JSON module cache; the checked-in table stays byte-identical.
const { resolve } = require('node:path');
if (process.env.NODE_ENV !== 'test') throw new Error('Write fixture preload requires NODE_ENV=test');
const table = require.resolve(resolve(__dirname, '../../crates/o8d/native-routes.json'));
const original = require(table);
const rows = structuredClone(original);
const row = rows.find(entry => entry.path === '/api/v2/chat-history');
if (!row || JSON.stringify(row.methods) !== '["GET"]') throw new Error('Unexpected production write-fixture table');
row.methods.push('POST');
require.cache[table].exports = rows;
