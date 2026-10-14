// Supplement the single-word shards without rewriting them. ECDICT is MIT licensed.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
const root = path.resolve(import.meta.dirname, '..');
const source = path.resolve(root, '..', 'wordtrail-mvp/dictionary/ecdict.csv');
function csv(line) {
  const cells = []; let cell = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && quoted && line[i + 1] === '"') { cell += c; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { cells.push(cell); cell = ''; }
    else cell += c;
  }
  cells.push(cell); return cells;
}
function compact(value = '') {
  return value.replaceAll('\\n', '；').replace(/\[[^\]]*\]/g, '').split(/[；;,，]/).map(x => x.trim()).filter(Boolean).slice(0, 3).join('；');
}
const phrases = Object.create(null);
let headers;
for await (const line of readline.createInterface({ input: fs.createReadStream(source, { encoding: 'utf8' }), crlfDelay: Infinity })) {
  if (!headers) { headers = csv(line.replace(/^\uFEFF/, '')); continue; }
  const row = csv(line), item = Object.fromEntries(headers.map((h, i) => [h, row[i] || '']));
  const word = item.word.trim().replace(/[’‘]/g, "'").replace(/\s+/g, ' '), key = word.toLowerCase();
  if (!/^[a-z]+(?:[-'][a-z]+)*(?: [a-z]+(?:[-'][a-z]+)*)+$/i.test(word)) continue;
  const meaning = compact(item.translation);
  if (meaning && !phrases[key]) phrases[key] = [word, meaning, item.phonetic.trim(), item.pos.trim(), compact(item.definition)];
}
const file = path.join(root, 'dictionary/manifest.json'), manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.phrases = { entries: Object.keys(phrases).length, shards: {} };
for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
  const shard = Object.fromEntries(Object.entries(phrases).filter(([key]) => key[0] === letter));
  const json = JSON.stringify(shard), filename = `${letter}-phrases.json`;
  fs.writeFileSync(path.join(root, 'dictionary', filename), json);
  manifest.phrases.shards[letter] = { file: filename, entries: Object.keys(shard).length, bytes: Buffer.byteLength(json) };
}
fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
console.log(`Prepared ${manifest.phrases.entries} phrases; largest shard ${Math.max(...Object.values(manifest.phrases.shards).map(x => x.bytes))} bytes`);
for (const key of ['take off', 'look forward to', 'in front of', 'give up', 'take care of']) console.log(key, phrases[key]?.[1] || 'unresolved');
