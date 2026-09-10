(() => {
  'use strict';

  const PAGE_WIDTH = 1680;
  const PAGE_HEIGHT = 2376;
  const PX_PER_MM = 8;
  const CARD_SIZE = 150;
  const ASSET_ROOT = new URL('.', document.currentScript?.src || location.href);
  let openCvPromise;

  function hash(value) {
    let output = 2166136261;
    for (const char of String(value)) {
      output ^= char.charCodeAt(0);
      output = Math.imul(output, 16777619);
    }
    return (output >>> 0).toString(16).padStart(8, '0');
  }

  function loadScript(source) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-wordtrail-source="${source}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') resolve();
        else {
          existing.addEventListener('load', resolve, { once: true });
          existing.addEventListener('error', reject, { once: true });
        }
        return;
      }
      const script = document.createElement('script');
      script.src = source;
      script.async = true;
      script.dataset.wordtrailSource = source;
      script.addEventListener('load', () => { script.dataset.loaded = 'true'; resolve(); }, { once: true });
      script.addEventListener('error', () => reject(new Error('OpenCV 识别组件加载失败，请确认网站文件完整')), { once: true });
      document.head.append(script);
    });
  }

  async function openCv() {
    if (!openCvPromise) openCvPromise = (async () => {
      if (!window.cv) await loadScript(new URL('vendor/opencv.js', ASSET_ROOT).href);
      let runtime = window.cv;
      if (runtime && typeof runtime.then === 'function') runtime = await runtime;
      if (runtime?.Mat) return runtime;
      return new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (window.cv?.Mat) { clearInterval(timer); resolve(window.cv); }
          else if (Date.now() - started > 30000) { clearInterval(timer); reject(new Error('OpenCV 初始化超时，请刷新后重试')); }
        }, 100);
      });
    })();
    return openCvPromise;
  }

  function imageFromDataUrl(source) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('无法读取图片，请换用清晰的 JPG 或 PNG'));
      image.src = source;
    });
  }

  function sourceCanvas(image) {
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(1, 2400 / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function orderQuad(points) {
    const bySum = [...points].sort((a, b) => a.x + a.y - b.x - b.y);
    const byDiff = [...points].sort((a, b) => a.y - a.x - (b.y - b.x));
    return [bySum[0], byDiff[0], bySum.at(-1), byDiff.at(-1)];
  }

  function findPaperQuad(cv, source) {
    const gray = new cv.Mat();
    const blurred = new cv.Mat();
    const edges = new cv.Mat();
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
    let winner = null;
    try {
      cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      cv.Canny(blurred, edges, 45, 135);
      cv.dilate(edges, edges, kernel);
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      const minimumArea = source.cols * source.rows * 0.22;
      for (let index = 0; index < contours.size(); index++) {
        const contour = contours.get(index);
        const perimeter = cv.arcLength(contour, true);
        const approximate = new cv.Mat();
        cv.approxPolyDP(contour, approximate, perimeter * 0.025, true);
        const area = Math.abs(cv.contourArea(approximate));
        if (approximate.rows === 4 && area >= minimumArea && (!winner || area > winner.area)) {
          const values = approximate.data32S;
          winner = { area, points: orderQuad(Array.from({ length: 4 }, (_, point) => ({ x: values[point * 2], y: values[point * 2 + 1] }))) };
        }
        approximate.delete();
        contour.delete();
      }
    } finally {
      gray.delete(); blurred.delete(); edges.delete(); contours.delete(); hierarchy.delete(); kernel.delete();
    }
    if (winner) return winner.points;
    const ratio = source.cols / source.rows;
    if (Math.abs(ratio - 1 / Math.sqrt(2)) < 0.12 || Math.abs(ratio - Math.sqrt(2)) < 0.12) {
      return orderQuad([{ x: 0, y: 0 }, { x: source.cols - 1, y: 0 }, { x: source.cols - 1, y: source.rows - 1 }, { x: 0, y: source.rows - 1 }]);
    }
    throw new Error('没有找到完整纸张边缘；请把整张答题卡平放，并让四角都进入画面');
  }

  function rectify(cv, canvas) {
    const source = cv.imread(canvas);
    let transformed;
    try {
      const [topLeft, topRight, bottomRight, bottomLeft] = findPaperQuad(cv, source);
      const horizontal = (distance(topLeft, topRight) + distance(bottomLeft, bottomRight)) / 2;
      const vertical = (distance(topLeft, bottomLeft) + distance(topRight, bottomRight)) / 2;
      const landscape = horizontal > vertical;
      const width = landscape ? 2970 : 2100;
      const height = landscape ? 2100 : 2970;
      const from = cv.matFromArray(4, 1, cv.CV_32FC2, [topLeft.x, topLeft.y, topRight.x, topRight.y, bottomRight.x, bottomRight.y, bottomLeft.x, bottomLeft.y]);
      const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
      const matrix = cv.getPerspectiveTransform(from, to);
      transformed = new cv.Mat();
      cv.warpPerspective(source, transformed, matrix, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
      from.delete(); to.delete(); matrix.delete();
    } finally {
      source.delete();
    }
    const output = document.createElement('canvas');
    cv.imshow(output, transformed);
    transformed.delete();
    return output;
  }

  function oriented(source, turns) {
    const canvas = document.createElement('canvas');
    canvas.width = PAGE_WIDTH;
    canvas.height = PAGE_HEIGHT;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    context.save();
    if (turns === 0) context.drawImage(source, 0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    if (turns === 1) { context.translate(PAGE_WIDTH, 0); context.rotate(Math.PI / 2); context.drawImage(source, 0, 0, PAGE_HEIGHT, PAGE_WIDTH); }
    if (turns === 2) { context.translate(PAGE_WIDTH, PAGE_HEIGHT); context.rotate(Math.PI); context.drawImage(source, 0, 0, PAGE_WIDTH, PAGE_HEIGHT); }
    if (turns === 3) { context.translate(0, PAGE_HEIGHT); context.rotate(-Math.PI / 2); context.drawImage(source, 0, 0, PAGE_HEIGHT, PAGE_WIDTH); }
    context.restore();
    return canvas;
  }

  function readVerificationCode(canvas) {
    if (!window.jsQR) throw new Error('二维码识别组件未加载');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const x = 0;
    const y = Math.floor(PAGE_HEIGHT * 0.66);
    const width = Math.floor(PAGE_WIDTH * 0.46);
    const height = PAGE_HEIGHT - y;
    const pixels = context.getImageData(x, y, width, height);
    const result = jsQR(pixels.data, width, height, { inversionAttempts: 'attemptBoth' });
    return result?.data || '';
  }

  function parseVerificationCode(value) {
    const parts = String(value || '').split('|');
    if (parts.length !== 7 || parts[0] !== 'WT1') throw new Error('没有读到词轨答题卡核验码；请上传考试表末尾的“错题勾选卡”页');
    const unsigned = parts.slice(0, 6).join('|');
    if (hash(unsigned) !== parts[6]) throw new Error('页面核验码校验失败，请重新拍摄完整答题卡');
    return { plan_id: parts[1], week_id: parts[2], paper_id: parts[3], version: Number(parts[4]), card_page: Number(parts[5]) };
  }

  function matchingPage(rectified) {
    for (let turns = 0; turns < 4; turns++) {
      const canvas = oriented(rectified, turns);
      const code = readVerificationCode(canvas);
      if (code) return { canvas, metadata: parseVerificationCode(code) };
    }
    throw new Error('未识别到页面核验码；请拍摄错题勾选卡整页，避免阴影、反光和遮挡');
  }

  function diskStats(pixels, centerX, centerY, radius = 4) {
    let total = 0;
    let darkness = 0;
    let count = 0;
    for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
      if (x * x + y * y > radius * radius) continue;
      const offset = ((Math.round(centerY + y) * PAGE_WIDTH) + Math.round(centerX + x)) * 4;
      const gray = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
      total += gray;
      if (gray < 145) darkness++;
      count++;
    }
    return { mean: total / Math.max(1, count), dark: darkness / Math.max(1, count) };
  }

  function readBubbles(canvas, metadata, itemCount) {
    const pixels = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, PAGE_WIDTH, PAGE_HEIGHT).data;
    const start = (metadata.card_page - 1) * CARD_SIZE;
    const count = Math.max(0, Math.min(CARD_SIZE, itemCount - start));
    const selected = [];
    const uncertain = [];
    for (let index = 0; index < count; index++) {
      const row = Math.floor(index / 10);
      const column = index % 10;
      const left = diskStats(pixels, (18 + column * 17.4 + 3.2) * PX_PER_MM, (48 + row * 13.5) * PX_PER_MM);
      const reference = diskStats(pixels, (18 + column * 17.4 + 7.7) * PX_PER_MM, (48 + row * 13.5) * PX_PER_MM);
      const darkDelta = left.dark - reference.dark;
      const grayDelta = reference.mean - left.mean;
      if ((darkDelta >= 0.16 && grayDelta >= 15) || (left.dark >= 0.42 && grayDelta >= 9)) selected.push(start + index + 1);
      else if (darkDelta >= 0.08 && grayDelta >= 8) uncertain.push(start + index + 1);
    }
    return { selected, uncertain, count };
  }

  function verify(metadata, expected) {
    if (metadata.plan_id !== expected.plan_id || metadata.week_id !== expected.week_id || metadata.paper_id !== expected.paper_id || metadata.version !== Number(expected.version)) {
      throw new Error('这张答题卡不属于当前计划、当前周期或当前考试，请选择对应页面');
    }
    const pages = Math.max(1, Math.ceil(expected.item_count / CARD_SIZE));
    if (!Number.isInteger(metadata.card_page) || metadata.card_page < 1 || metadata.card_page > pages) throw new Error('答题卡页码不在当前考试范围内');
  }

  async function scan(imageDataUrl, expected) {
    const [cv, image] = await Promise.all([openCv(), imageFromDataUrl(imageDataUrl)]);
    const corrected = rectify(cv, sourceCanvas(image));
    const { canvas, metadata } = matchingPage(corrected);
    verify(metadata, expected);
    const result = readBubbles(canvas, metadata, expected.item_count);
    const uncertainText = result.uncertain.length ? `；另有 ${result.uncertain.length} 个浅色标记未自动计入，请人工核对` : '';
    return {
      suggested_wrong_numbers: result.selected,
      uncertain_numbers: result.uncertain,
      card_page: metadata.card_page,
      message: `已核验第 ${metadata.card_page} 张勾选卡，识别到 ${result.selected.length} 个明确错题${uncertainText}。结果尚未保存，请核对后点击确认。`
    };
  }

  window.WordtrailOMR = { scan, __test: { hash, parseVerificationCode, readBubbles } };
})();
