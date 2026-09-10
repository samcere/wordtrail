import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [
  ['node_modules/xlsx/dist/xlsx.full.min.js', 'vendor/xlsx.full.min.js'],
  ['node_modules/@techstark/opencv-js/dist/opencv.js', 'vendor/opencv.js'],
  ['node_modules/jsqr/dist/jsQR.js', 'vendor/jsQR.js'],
  ['node_modules/qrcode-generator/dist/qrcode.js', 'vendor/qrcode.js'],
];
for (const [from, to] of files) {
  const source = path.join(root, from); const target = path.join(root, to);
  if (!fs.existsSync(source)) throw new Error(`Missing ${from}; run npm install first.`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  console.log(`${from} -> ${to}`);
}
