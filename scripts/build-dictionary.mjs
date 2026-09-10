import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, '..', 'wordtrail-mvp', 'dictionary', 'ecdict.csv');
const outDir = path.join(root, 'dictionary');
if (!fs.existsSync(source)) throw new Error(`Dictionary source missing: ${source}`);

function parseCsv(line) {
  const values = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) { const char = line[i]; if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(value); value = ''; } else value += char; }
  values.push(value); return values;
}
function compact(value = '') {
  const parts = [];
  for (let line of String(value).replaceAll('\\n', '\n').split(/\r?\n/)) { line = line.replace(/\[.*?\]/g, '').replace(/^[ ，,;；]+|[ ，,;；]+$/g, ''); if (!line || line.startsWith('[')) continue; const prefix = line.match(/^((?:n|v|vi|vt|adj|adv|prep|conj|pron|art|aux)\.)\s*/i); const senses = line.slice(prefix?.[0].length || 0).split(/[；;,，]/).map((item) => item.trim()).filter(Boolean); for (const [index, sense] of senses.entries()) { parts.push(`${prefix && index === 0 ? `${prefix[1]} ` : ''}${sense}`); if (parts.length === 3) return parts.join('；'); } } return parts.join('；');
}

fs.mkdirSync(outDir, { recursive: true });
const shards = Object.fromEntries('abcdefghijklmnopqrstuvwxyz'.split('').map((letter) => [letter, Object.create(null)]));
const stream = fs.createReadStream(source, { encoding: 'utf8' });
const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
let headers = null; let count = 0;
for await (const line of lines) {
  if (!headers) { headers = parseCsv(line.replace(/^\uFEFF/, '')); continue; }
  const row = parseCsv(line); const item = Object.fromEntries(headers.map((header, index) => [header, row[index] || '']));
  const word = String(item.word || '').trim(); const key = word.toLowerCase(); const meaning = compact(item.translation);
  if (!/^[a-z]+(?:[-'][a-z]+)*$/i.test(word) || !meaning) continue;
  const shard = shards[key[0]]; if (shard && !shard[key]) { shard[key] = [word, meaning, String(item.phonetic || '').trim(), String(item.pos || '').trim(), compact(item.definition)]; count++; }
}
const manifest = { version: 'ECDICT 2026.09 static', entries: count, shards: {} };
for (const letter of Object.keys(shards)) { const json = JSON.stringify(shards[letter]); const target = path.join(outDir, `${letter}.json`); fs.writeFileSync(target, json); manifest.shards[letter] = { file: `${letter}.json`, entries: Object.keys(shards[letter]).length, bytes: Buffer.byteLength(json) }; console.log(`${letter}: ${manifest.shards[letter].entries} entries, ${manifest.shards[letter].bytes} bytes`); }
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Prepared ${count} dictionary entries.`);
