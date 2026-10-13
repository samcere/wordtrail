import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [
  ['node_modules/xlsx/dist/xlsx.full.min.js', 'vendor/xlsx.full.min.js'],
  ['node_modules/@techstark/opencv-js/dist/opencv.js', 'vendor/opencv.js'],
  ['node_modules/jsqr/dist/jsQR.js', 'vendor/jsQR.js'],
  ['node_modules/qrcode-generator/dist/qrcode.js', 'vendor/qrcode.js'],
  ['node_modules/pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib.min.js'],
  ['node_modules/@pdf-lib/fontkit/dist/fontkit.umd.min.js', 'vendor/fontkit.umd.min.js'],
  ['node_modules/katex/dist/katex.min.js', 'vendor/katex/katex.min.js'],
  ['node_modules/katex/dist/katex.min.css', 'vendor/katex/katex.min.css'],
  ['node_modules/katex/LICENSE', 'vendor/katex/LICENSE'],
  ['node_modules/html2canvas/dist/html2canvas.min.js', 'vendor/html2canvas.min.js'],
  ['node_modules/html2canvas/LICENSE', 'vendor/LICENSE-HTML2CANVAS.txt'],
];
for (const [from, to] of files) {
  const source = path.join(root, from); const target = path.join(root, to);
  if (!fs.existsSync(source)) throw new Error(`Missing ${from}; run npm install first.`);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  console.log(`${from} -> ${to}`);
}
fs.cpSync(path.join(root, 'node_modules/katex/dist/fonts'), path.join(root, 'vendor/katex/fonts'), { recursive: true });
