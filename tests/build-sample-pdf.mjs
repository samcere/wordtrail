import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
globalThis.window = globalThis;
globalThis.location = { href: `file:///${root.replaceAll('\\', '/')}/index.html` };
globalThis.document = { currentScript: { src: `file:///${root.replaceAll('\\', '/')}/static-service.js` } };
globalThis.qrcode = new Function(`${await fs.readFile(path.join(root, 'vendor', 'qrcode.js'), 'utf8')}; return qrcode;`)();
new Function(await fs.readFile(path.join(root, 'static-service.js'), 'utf8'))();

const words = Array.from({ length: 35 }, (_, index) => ({
  id: `word_${index + 1}`,
  word: `vocabulary${index + 1}`,
  phonetic: '/vəˈkæbjələri/',
  part_of_speech: 'n.',
  meaning: `第 ${index + 1} 个测试词的常用释义；用于检查排版`
}));
const paper = { id: 'paper_sample', version: 1, label: '周测', items: words.map((word, index) => ({ no: index + 1, word })) };
const plan = { id: 'plan_sample', name: '静态版打印验收', start_week: '2026-09-09', week: { id: 'week_sample' } };
const pdf = WordtrailService.__test.createPdf(plan, 'exam', paper);
const outputDir = path.join(here, 'output');
await fs.mkdir(outputDir, { recursive: true });
const output = path.join(outputDir, 'sample-exam.pdf');
await fs.writeFile(output, new Uint8Array(await pdf.arrayBuffer()));
console.log(output);
