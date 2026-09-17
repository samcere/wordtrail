(() => {
  'use strict';

  const DB_NAME = 'wordtrail-static-v010';
  const DB_VERSION = 1;
  const DICTIONARY_VERSION = 'ECDICT 2026.09 · 静态分片';
  const ITEMS_PER_COLUMN = 30;
  const ITEMS_PER_PAGE = ITEMS_PER_COLUMN * 2;
  const CARDS_PER_PAGE = 150;
  const MM = 72 / 25.4;
  const ASSET_ROOT = new URL('.', document.currentScript?.src || location.href);
  const objectUrls = new Map();
  const dictionaryCache = new Map();
  let databasePromise;

  const emptyState = () => ({ wordbooks: [], plans: [], documents: [], active_plan_id: null });
  const now = () => new Date().toLocaleString('zh-CN', { hour12: false }).replaceAll('/', '-');
  const newId = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const normal = (value) => String(value || '').trim().replaceAll('’', "'").toLowerCase();
  const safeName = (value) => String(value || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 48) || '词轨文档';
  const shuffled = (items) => [...items].sort(() => Math.random() - 0.5);
  const find = (items, id) => items.find((item) => item.id === id);

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
        if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开浏览器数据仓库'));
    });
    return databasePromise;
  }
  async function storeAction(name, mode, action) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(name, mode); const store = transaction.objectStore(name); let result;
      try { result = action(store); } catch (error) { reject(error); return; }
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error || new Error('浏览器存储操作失败'));
      transaction.onabort = () => reject(transaction.error || new Error('浏览器存储操作被中止'));
    });
  }
  async function loadState() {
    const value = await storeAction('state', 'readonly', (store) => store.get('main'));
    return value ? { ...emptyState(), ...value } : emptyState();
  }
  const saveState = (state) => storeAction('state', 'readwrite', (store) => store.put(state, 'main'));
  const saveDocumentBlob = (id, blob) => storeAction('documents', 'readwrite', (store) => store.put({ id, blob }));
  const loadDocumentBlob = (id) => storeAction('documents', 'readonly', (store) => store.get(id));
  const loadAllDocumentBlobs = () => storeAction('documents', 'readonly', (store) => store.getAll());

  function planFor(state, id) {
    const plan = find(state.plans, id || state.active_plan_id);
    if (!plan) throw new Error('找不到学习计划');
    return plan;
  }
  function bookFor(state, id) {
    const book = find(state.wordbooks, id);
    if (!book) throw new Error('找不到词表');
    return book;
  }
  function planWords(state, plan, frozen = false) {
    const book = bookFor(state, plan.wordbook_id);
    const ids = frozen && plan.week.frozen_word_ids?.length ? plan.week.frozen_word_ids : plan.week.word_ids;
    return ids.map((id) => find(book.words, id)).filter(Boolean);
  }
  function estimateCycles(total, target) {
    if (!total) return 0;
    if (total <= target) return 1;
    const review = Math.max(1, Math.round(target * 0.1));
    return 1 + Math.ceil((total - target) / Math.max(1, target - review));
  }
  function buildCycle(state, plan) {
    const book = bookFor(state, plan.wordbook_id); const cycles = plan.cycles ||= [];
    const target = Math.max(1, Number(plan.weekly_target || book.words.length || 1));
    const learned = new Set(cycles.flatMap((cycle) => cycle.new_word_ids || []));
    const unseen = book.words.filter((word) => !learned.has(word.id)).map((word) => word.id);
    if (!unseen.length) return null;
    const number = cycles.length + 1; const history = cycles.flatMap((cycle) => cycle.word_ids || []);
    let reviewCount = number > 1 ? Math.min(history.length, Math.max(1, Math.round(target * 0.1))) : 0;
    const newCount = Math.min(unseen.length, Math.max(1, target - reviewCount));
    if (unseen.length < target - reviewCount) reviewCount = Math.min(history.length, Math.max(0, target - newCount));
    const wrongFirst = [...cycles].reverse().flatMap((cycle) => cycle.wrong_word_ids || []);
    const reviewPool = [...new Set([...wrongFirst, ...[...history].reverse()])];
    const review = shuffled(reviewPool).slice(0, reviewCount);
    const cycle = { id: newId('week'), number, word_ids: shuffled([...unseen.slice(0, newCount), ...review]), new_word_ids: unseen.slice(0, newCount), previous_word_ids: review, frozen_word_ids: [], papers: [], status: 'active', created_at: now() };
    cycles.push(cycle); plan.week = cycle; return cycle;
  }
  function gradeCycle(cycle) {
    const first = cycle.papers.find((paper) => paper.version === 1); const second = cycle.papers.find((paper) => paper.version === 2);
    if (!first?.wrong_numbers || !second?.wrong_numbers) return '';
    const score = Math.round(((1 - first.wrong_numbers.length / Math.max(1, first.items.length)) * 0.6 + (1 - second.wrong_numbers.length / Math.max(1, second.items.length)) * 0.4) * 100);
    cycle.score = score; cycle.wrong_word_ids = second.items.filter((item) => second.wrong_numbers.includes(item.no)).map((item) => item.word.id);
    if (score >= 95 && !second.wrong_numbers.length) return 'S+';
    if (score >= 90) return 'S'; if (score >= 80) return 'A'; if (score >= 70) return 'B'; if (score >= 60) return 'C'; return 'D';
  }
  function paperForVersion(state, plan, version) {
    const papers = plan.week.papers; const existing = papers.find((paper) => paper.version === version); if (existing) return existing;
    let words; let types;
    if (version === 1) {
      words = planWords(state, plan); if (!words.length) throw new Error('请先至少加入 1 个本周期词条');
      plan.week.frozen_word_ids = [...plan.week.word_ids]; words = shuffled(planWords(state, plan, true)); types = words.map(() => 'base');
    } else if (version === 2) {
      const prior = papers.find((paper) => paper.version === 1); if (!prior || !Array.isArray(prior.wrong_numbers)) throw new Error('请先提交周测错词');
      const wrong = prior.items.filter((item) => prior.wrong_numbers.includes(item.no)).map((item) => item.word);
      const correct = prior.items.filter((item) => !prior.wrong_numbers.includes(item.no)).map((item) => item.word);
      const review = shuffled(correct).slice(0, correct.length ? Math.max(1, Math.ceil(correct.length / 5)) : 0);
      const mixed = shuffled([...wrong.map((word) => ({ word, type: 'error' })), ...review.map((word) => ({ word, type: 'review' }))]);
      words = mixed.map((item) => item.word); types = mixed.map((item) => item.type);
    } else throw new Error('每个周期只包含周测和一次复测');
    const paper = { id: newId('paper'), version, label: version === 1 ? '周测' : '复测', created_at: now(), items: words.map((word, index) => ({ no: index + 1, word, source_type: types[index] })) };
    papers.push(paper); return paper;
  }

  async function loadDictionaryShard(letter) {
    if (!/^[a-z]$/.test(letter)) return {};
    if (!dictionaryCache.has(letter)) {
      const asset = new URL(`dictionary/${letter}.json`, ASSET_ROOT);
      dictionaryCache.set(letter, fetch(asset).then((response) => { if (!response.ok) throw new Error(`词典分片 ${letter.toUpperCase()} 加载失败（HTTP ${response.status} · ${asset.pathname}）`); return response.json(); }));
    }
    return dictionaryCache.get(letter);
  }
  async function dictionaryFor(words) {
    const letters = [...new Set(words.map((word) => normal(word)[0]).filter((letter) => /^[a-z]$/.test(letter)))];
    const shards = new Map(await Promise.all(letters.map(async (letter) => [letter, await loadDictionaryShard(letter)])));
    const results = new Map();
    for (const word of words) { const key = normal(word); const record = shards.get(key[0])?.[key]; if (record) results.set(key, { lemma: record[0], meaning: record[1], phonetic: record[2], part_of_speech: record[3], definition: record[4] }); }
    return results;
  }

  const aliases = { '单词': 'word', '英文': 'word', '英语': 'word', '词汇': 'word', word: 'word', english: 'word', term: 'word', words: 'words', data: 'data', items: 'items', vocabulary: 'vocabulary', list: 'list', '释义': 'meaning', '中文': 'meaning', '翻译': 'meaning', definition: 'meaning', translation: 'meaning', meaning: 'meaning' };
  function canonical(value) { const key = String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, ''); return aliases[key] || key; }
  function extractWord(value) { const match = String(value || '').replace(/\u200b/g, '').trim().replace(/^["'“”‘’（）()\[\]]+|["'“”‘’（）()\[\]]+$/g, '').match(/(?<![a-z0-9])([a-z]+(?:[-'][a-z]+)*)(?![a-z0-9])/i); return match?.[1] || null; }
  function candidate(value, source) { const word = extractWord(value); return word ? { word, normalized: normal(word), source } : null; }
  function rowsToCandidates(rows, source) {
    if (!rows.length) return []; const headers = rows[0].map(canonical); const columns = headers.map((value, index) => value === 'word' ? index : -1).filter((index) => index >= 0); const start = columns.length ? 1 : 0; const result = [];
    rows.slice(start).forEach((row, index) => { const cells = columns.length ? columns.map((column) => row[column]) : row; const item = cells.map((cell) => candidate(cell, `${source} · 第 ${index + start + 1} 行`)).find(Boolean); if (item) result.push(item); }); return result;
  }
  function jsonCandidates(value, path = '$') {
    if (typeof value === 'string') return [candidate(value, path)].filter(Boolean);
    if (Array.isArray(value)) return value.flatMap((entry, index) => jsonCandidates(entry, `${path}[${index}]`));
    if (!value || typeof value !== 'object') return [];
    const wordKey = Object.keys(value).find((key) => canonical(key) === 'word'); if (wordKey) return [candidate(value[wordKey], path)].filter(Boolean);
    const containers = Object.keys(value).filter((key) => ['words', 'data', 'items', 'vocabulary', 'list'].includes(canonical(key))); if (containers.length) return containers.flatMap((key) => jsonCandidates(value[key], `${path}.${key}`));
    return Object.entries(value).flatMap(([key, entry]) => ['meaning', 'phonetic', 'partofspeech', 'example', 'note'].includes(canonical(key)) ? [] : jsonCandidates(entry, `${path}.${key}`));
  }
  function csvRows(text) {
    const rows = []; let row = []; let value = ''; let quoted = false;
    for (let index = 0; index < text.length; index++) { const char = text[index]; const next = text[index + 1]; if (char === '"' && quoted && next === '"') { value += '"'; index++; } else if (char === '"') quoted = !quoted; else if (!quoted && (char === ',' || char === '\t' || char === '，')) { row.push(value.trim()); value = ''; } else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && next === '\n') index++; row.push(value.trim()); if (row.some(Boolean)) rows.push(row); row = []; value = ''; } else value += char; }
    row.push(value.trim()); if (row.some(Boolean)) rows.push(row); return rows;
  }
  function bytesFromDataUrl(value) { const binary = atob(String(value || '').split(',').at(-1)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
  function decoded(bytes) { for (const encoding of ['utf-8', 'utf-16', 'gb18030']) { try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); } catch {} } return new TextDecoder().decode(bytes); }
  function importCandidates(filename, content) {
    const bytes = bytesFromDataUrl(content); const suffix = filename.toLowerCase().split('.').at(-1); const text = decoded(bytes);
    if (suffix === 'txt') return text.split(/\r?\n/).flatMap((line, index) => !line.trim() || /^(#|\/\/)/.test(line.trim()) || canonical(line) === 'word' ? [] : [candidate(line, `第 ${index + 1} 行`)].filter(Boolean));
    if (suffix === 'csv') return rowsToCandidates(csvRows(text), 'CSV');
    if (suffix === 'json') { try { return jsonCandidates(JSON.parse(text)); } catch { throw new Error('JSON 格式不正确'); } }
    if (suffix === 'xls' || suffix === 'xlsx') { if (!window.XLSX) throw new Error('Excel 解析组件未加载'); const workbook = XLSX.read(bytes, { type: 'array' }); return workbook.SheetNames.flatMap((name) => rowsToCandidates(XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' }), name)); }
    throw new Error('只支持 TXT、JSON、CSV、XLS 或 XLSX 文件');
  }
  async function preparedImport(filename, content, selected = null) {
    const accepted = selected ? new Set(selected.map(normal)) : null; const candidates = importCandidates(filename, content); if (!candidates.length) throw new Error('未识别到英文单词');
    const dictionary = await dictionaryFor(candidates.map((item) => item.word)); const seen = new Set(); let duplicates = 0;
    const records = candidates.flatMap((item) => { if (accepted && !accepted.has(item.normalized)) return []; if (seen.has(item.normalized)) { duplicates++; return []; } seen.add(item.normalized); const hit = dictionary.get(item.normalized); return [{ id: newId('w'), word: item.word, meaning: hit?.meaning || '', phonetic: hit?.phonetic || '', part_of_speech: hit?.part_of_speech || '', example: '', note: '', source_row: item.source, normalized_word: item.normalized, dictionary_lemma: hit?.lemma || '', dictionary_senses: hit ? [hit.meaning] : [], meaning_source: hit ? 'dictionary' : 'unresolved', dictionary_version: hit ? DICTIONARY_VERSION : '', match_status: hit ? 'matched' : 'unresolved' }]; });
    if (!records.length) throw new Error('请至少保留 1 个可导入的英文词');
    const matched = records.filter((word) => word.match_status === 'matched').length;
    return [records, { candidate_count: records.length, duplicate_count: duplicates, matched_count: matched, unresolved_count: records.length - matched }];
  }

  function hash(value) { let output = 2166136261; for (const char of String(value)) { output ^= char.charCodeAt(0); output = Math.imul(output, 16777619); } return (output >>> 0).toString(16).padStart(8, '0'); }
  function pdfHex(value) { return [...String(value)].map((char) => char.charCodeAt(0).toString(16).padStart(4, '0')).join(''); }
  function pdfText(value, x, y, size = 9) { return `BT /F1 ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <FEFF${pdfHex(value)}> Tj ET`; }
  function pdfLatin(value, x, y, size = 9) { return `BT /F2 ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${String(value).replace(/([\\()])/g, '\\$1')}) Tj ET`; }
  const pdfLine = (x1, y1, x2, y2) => `${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`;
  const pdfRect = (x, y, width, height, fill = false) => `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re ${fill ? 'f' : 'S'}`;
  function pdfCircle(x, y, radius, fill = false) { const k = 0.5522847498 * radius; return `${(x + radius).toFixed(2)} ${y.toFixed(2)} m ${(x + radius).toFixed(2)} ${(y + k).toFixed(2)} ${(x + k).toFixed(2)} ${(y + radius).toFixed(2)} ${x.toFixed(2)} ${(y + radius).toFixed(2)} c ${(x - k).toFixed(2)} ${(y + radius).toFixed(2)} ${(x - radius).toFixed(2)} ${(y + k).toFixed(2)} ${(x - radius).toFixed(2)} ${y.toFixed(2)} c ${(x - radius).toFixed(2)} ${(y - k).toFixed(2)} ${(x - k).toFixed(2)} ${(y - radius).toFixed(2)} ${x.toFixed(2)} ${(y - radius).toFixed(2)} c ${(x + k).toFixed(2)} ${(y - radius).toFixed(2)} ${(x + radius).toFixed(2)} ${(y - k).toFixed(2)} ${(x + radius).toFixed(2)} ${y.toFixed(2)} c ${fill ? 'f' : 'S'}`; }
  function qrCommands(payload, x, y, size) {
    if (!window.qrcode) return []; const qr = qrcode(0, 'M'); qr.addData(payload, 'Byte'); qr.make(); const count = qr.getModuleCount(); const quiet = 4; const cell = size / (count + quiet * 2); const commands = ['0 0 0 rg'];
    for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) if (qr.isDark(row, column)) commands.push(pdfRect(x + (column + quiet) * cell, y + (count - row - 1 + quiet) * cell, cell + 0.08, cell + 0.08, true)); return commands;
  }
  function markerCommands(x, y) { const commands = []; for (const [radius, black] of [[4, true], [2.45, false], [1.35, true], [0.55, false], [0.28, true]]) { commands.push(black ? '0 0 0 rg' : '1 1 1 rg', pdfCircle(x * MM, y * MM, radius * MM, true)); } return commands; }
  function buildPdf(pages) {
    const objects = []; const put = (body) => { objects.push(body); return objects.length; };
    const catalog = put('<< /Type /Catalog /Pages 2 0 R >>'); const pagesId = put(''); const cjk = put('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>'); put('<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >>'); const latin = put('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); const pageIds = [];
    for (const commands of pages) { const stream = commands.join('\n'); const content = put(`<< /Length ${new TextEncoder().encode(stream).length} >>\nstream\n${stream}\nendstream`); pageIds.push(put(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 ${cjk} 0 R /F2 ${latin} 0 R >> >> /Contents ${content} 0 R >>`)); }
    objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
    let output = '%PDF-1.4\n%WT01\n'; const offsets = [0]; objects.forEach((body, index) => { offsets.push(new TextEncoder().encode(output).length); output += `${index + 1} 0 obj\n${body}\nendobj\n`; }); const xref = new TextEncoder().encode(output).length; output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`; return new Blob([new TextEncoder().encode(output)], { type: 'application/pdf' });
  }
  function header(commands, title, plan, page) { commands.push('0.08 0.16 0.27 rg', pdfText(title, 18 * MM, 282 * MM, 18), '0.55 0.65 0.70 RG 0.6 w', pdfLine(18 * MM, 278 * MM, 192 * MM, 278 * MM), pdfText(`${plan.name} · ${plan.start_week} · 第 ${page} 页`, 18 * MM, 271 * MM, 8)); }
  function cardPayload(plan, paper, cardPage) { const unsigned = `WT1|${plan.id}|${plan.week.id}|${paper.id}|${paper.version}|${cardPage}`; return `${unsigned}|${hash(unsigned)}`; }
  function createLegacyPdf(plan, kind, source) {
    const pages = []; const paper = kind === 'study' ? null : source; const list = kind === 'study' ? source : paper.items.map((item) => item.word); const title = kind === 'study' ? '背诵表' : kind === 'answer' ? `${paper.label} · 答案表` : paper.label;
    for (let start = 0; start < Math.max(1, list.length); start += ITEMS_PER_PAGE) { const segment = list.slice(start, start + ITEMS_PER_PAGE); const commands = []; header(commands, title, plan, Math.floor(start / ITEMS_PER_PAGE) + 1); if (kind === 'exam') commands.push(pdfText('姓名：__________________　日期：__________________　看英文填写常用中文义。', 18 * MM, 259 * MM, 8)); const yHead = kind === 'exam' ? 249 * MM : 255 * MM; const headings = kind === 'exam' ? ['序号', '英文单词', '中文释义（手写）', '把握', '复盘'] : ['序号', '英文单词', '音标 / 词性', '常用释义']; const xs = kind === 'exam' ? [18, 31, 86, 157, 180] : [18, 31, 84, 132]; headings.forEach((heading, index) => commands.push(pdfText(heading, xs[index] * MM, yHead, 8))); segment.forEach((word, index) => { const y = yHead - (index + 1) * 7 * MM; const no = start + index + 1; commands.push('0.82 0.85 0.86 RG 0.35 w', pdfLine(18 * MM, y - 2 * MM, 192 * MM, y - 2 * MM), pdfLatin(String(no).padStart(2, '0'), 18 * MM, y, 8), pdfLatin(word.word.slice(0, 30), 31 * MM, y, 9)); if (kind === 'exam') commands.push(pdfLine(86 * MM, y - 0.5 * MM, 151 * MM, y - 0.5 * MM), pdfText('□ 熟　□ 犹豫', 157 * MM, y, 7), pdfText('□ 复习', 180 * MM, y, 7)); else commands.push(pdfLatin(`${word.phonetic || ''} ${word.part_of_speech || ''}`.slice(0, 28), 84 * MM, y, 7), pdfText((word.meaning || '尚未补全释义').slice(0, 29), 132 * MM, y, 8)); }); commands.push(pdfText(`词轨 Wordtrail · 本页 ${segment.length} 词 · 每页最多 30 词`, 18 * MM, 12 * MM, 8)); pages.push(commands); }
    if (kind === 'exam') for (let start = 0; start < Math.max(1, paper.items.length); start += CARDS_PER_PAGE) { const cardPage = Math.floor(start / CARDS_PER_PAGE) + 1; const segment = paper.items.slice(start, start + CARDS_PER_PAGE); const commands = []; header(commands, `${paper.label} · 错题勾选卡`, plan, Math.ceil(list.length / ITEMS_PER_PAGE) + cardPage); commands.push(pdfText(`第 ${cardPage} / ${Math.max(1, Math.ceil(paper.items.length / CARDS_PER_PAGE))} 张：答错时涂满左侧圆圈；右侧圆圈留空。`, 18 * MM, 268 * MM, 8), ...markerCommands(10, 10), ...markerCommands(200, 10), ...markerCommands(10, 287), ...markerCommands(200, 287)); segment.forEach((item, index) => { const row = Math.floor(index / 10); const column = index % 10; const x = 18 + column * 17.4; const y = 297 - 41 - (row + 1) * 13.5; commands.push('0.48 0.57 0.62 RG 0.55 w', pdfRect(x * MM, y * MM, 17.4 * MM, 13.5 * MM), pdfCircle((x + 3.2) * MM, (y + 6.5) * MM, 1.7 * MM), pdfCircle((x + 7.7) * MM, (y + 6.5) * MM, 1.7 * MM), '0.06 0.14 0.25 rg', pdfLatin(String(item.no).padStart(3, '0'), (x + 11.2) * MM, (y + 5.1) * MM, 8)); }); const payload = cardPayload(plan, paper, cardPage); commands.push(...qrCommands(payload, 18 * MM, 22 * MM, 18 * MM), pdfText('页面核验码：自动确认考试、周期与答题卡页码', 39 * MM, 28 * MM, 7.5), pdfLatin(`WT-OMR-STATIC · ${cardPage}/${Math.max(1, Math.ceil(paper.items.length / CARDS_PER_PAGE))}`, 39 * MM, 18 * MM, 8)); pages.push(commands); }
    return buildPdf(pages);
  }

  let pdfFontBytesPromise;
  let pdfFallbackFontPromise;
  async function loadPdfFontBytes() {
    if (!window.PDFLib || !window.fontkit) throw new Error('PDF 字体组件未加载，请刷新页面后重试');
    if (window.__WORDTRAIL_PDF_FONTS) return window.__WORDTRAIL_PDF_FONTS;
    if (!pdfFontBytesPromise) {
      const load = async (name) => {
        const response = await fetch(new URL(`vendor/${name}`, ASSET_ROOT));
        if (!response.ok) throw new Error(`无法加载 PDF 字体：${name}`);
        return new Uint8Array(await response.arrayBuffer());
      };
      pdfFontBytesPromise = Promise.all([
        load('WordtrailSansSC-Common.ttf'),
        load('NotoSans-Regular.ttf')
      ]).then(([cjk, latin]) => ({ cjk, latin }));
    }
    return pdfFontBytesPromise;
  }
  async function loadPdfFallbackFont() {
    if (window.__WORDTRAIL_PDF_FONTS?.fallback) return window.__WORDTRAIL_PDF_FONTS.fallback;
    if (!pdfFallbackFontPromise) {
      pdfFallbackFontPromise = fetch(new URL('vendor/WordtrailSansSC-Regular.ttf', ASSET_ROOT)).then(async (response) => {
        if (!response.ok) throw new Error('无法加载 PDF 中文备用字体');
        return new Uint8Array(await response.arrayBuffer());
      });
    }
    return pdfFallbackFontPromise;
  }
  const trimPdfText = (value, limit) => [...String(value || '')].slice(0, limit).join('');
  function pdfColor(hex) {
    const value = Number.parseInt(hex.replace('#', ''), 16);
    return window.PDFLib.rgb(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);
  }
  function drawPdfText(page, font, value, x, y, size = 9, color = '#142943') {
    page.drawText(String(value || ''), { x, y, size, font, color: pdfColor(color) });
  }
  function drawFittedPdfText(page, font, value, x, y, width, size, minSize = 6) {
    let text = String(value || '');
    let fontSize = size;
    while (fontSize > minSize && font.widthOfTextAtSize(text, fontSize) > width) fontSize -= 0.25;
    if (font.widthOfTextAtSize(text, fontSize) > width) {
      while (text && font.widthOfTextAtSize(`${text}…`, fontSize) > width) text = text.slice(0, -1);
      text += '…';
    }
    drawPdfText(page, font, text, x, y, fontSize);
  }
  function drawPdfLine(page, x1, y1, x2, y2, thickness = 0.35, color = '#d1d9dc') {
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness, color: pdfColor(color) });
  }
  function drawPdfHeader(page, font, title, plan, pageNumber) {
    drawPdfText(page, font, title, 18 * MM, 282 * MM, 18);
    drawPdfLine(page, 18 * MM, 278 * MM, 192 * MM, 278 * MM, 0.6, '#8ca6b3');
    drawPdfText(page, font, `${plan.name} · ${plan.start_week} · 第 ${pageNumber} 页`, 18 * MM, 271 * MM, 8);
  }
  function drawPdfMarker(page, x, y) {
    for (const [radius, color] of [[4, '#000000'], [2.45, '#ffffff'], [1.35, '#000000'], [0.55, '#ffffff'], [0.28, '#000000']]) {
      page.drawCircle({ x: x * MM, y: y * MM, size: radius * MM, color: pdfColor(color) });
    }
  }
  function drawPdfQr(page, payload, x, y, size) {
    if (!window.qrcode) return;
    const qr = qrcode(0, 'M'); qr.addData(payload, 'Byte'); qr.make();
    const count = qr.getModuleCount(); const quiet = 4; const cell = size / (count + quiet * 2);
    for (let row = 0; row < count; row++) for (let column = 0; column < count; column++) if (qr.isDark(row, column)) {
      page.drawRectangle({ x: x + (column + quiet) * cell, y: y + (count - row - 1 + quiet) * cell, width: cell + 0.08, height: cell + 0.08, color: pdfColor('#000000') });
    }
  }
  function drawWordSheetPage(pdfDocument, fonts, plan, kind, paper, list, start) {
    const page = pdfDocument.addPage(window.PDFLib.PageSizes.A4);
    const title = kind === 'study' ? '背诵表' : kind === 'answer' ? `${paper.label} · 答案表` : paper.label;
    const pageNumber = Math.floor(start / ITEMS_PER_PAGE) + 1;
    const segment = list.slice(start, start + ITEMS_PER_PAGE);
    const leftCount = Math.min(ITEMS_PER_COLUMN, Math.ceil(segment.length / 2));
    const columnCounts = [leftCount, segment.length - leftCount];
    drawPdfHeader(page, fonts.cjk, title, plan, pageNumber);
    if (kind === 'exam') drawPdfText(page, fonts.cjk, '姓名：__________________  日期：__________________  看英文填写常用中文义。', 18 * MM, 259 * MM, 8);
    const yHead = kind === 'exam' ? 249 : 255;
    const columnXs = [16, 108];
    drawPdfLine(page, 105 * MM, 26 * MM, 105 * MM, (yHead + 2) * MM, 0.55, '#d1d9dc');
    columnXs.forEach((x, column) => {
      const count = columnCounts[column];
      if (!count) return;
      const first = start + (column === 0 ? 0 : leftCount) + 1;
      const last = first + count - 1;
      drawPdfText(page, fonts.cjk, `${first}-${last}  ${kind === 'exam' ? '单词 / 中文释义（手写）' : '单词 / 音标 / 常用释义'}`, x * MM, yHead * MM, 7.5);
      drawPdfLine(page, x * MM, (yHead - 2) * MM, (x + 86) * MM, (yHead - 2) * MM, 0.6, '#8ca6b3');
    });
    segment.forEach((word, index) => {
      const column = index < leftCount ? 0 : 1;
      const row = column === 0 ? index : index - leftCount;
      const x = columnXs[column];
      const top = yHead - 3 - row * 7.4;
      const no = start + index + 1;
      drawPdfLine(page, x * MM, (top - 6.5) * MM, (x + 86) * MM, (top - 6.5) * MM);
      drawPdfText(page, fonts.latin, String(no).padStart(2, '0'), x * MM, (top - 2.3) * MM, 7.5);
      drawFittedPdfText(page, fonts.latin, word.word, (x + 9) * MM, (top - 2.3) * MM, (kind === 'exam' ? 40 : 35) * MM, 8.5, 6.5);
      if (kind === 'exam') {
        drawFittedPdfText(page, fonts.cjk, '□ 熟  □ 疑  □ 复', (x + 53) * MM, (top - 2.3) * MM, 31 * MM, 6.3, 5.8);
        drawPdfLine(page, (x + 9) * MM, (top - 5.3) * MM, (x + 84) * MM, (top - 5.3) * MM, 0.4, '#8ca6b3');
      } else {
        drawFittedPdfText(page, fonts.latin, `${word.phonetic || ''} ${word.part_of_speech || ''}`, (x + 46) * MM, (top - 2.3) * MM, 38 * MM, 6.7, 5.8);
        drawFittedPdfText(page, fonts.cjk, word.meaning || '尚未补全释义', (x + 9) * MM, (top - 5.1) * MM, 75 * MM, 7.2, 6);
      }
    });
    drawPdfText(page, fonts.cjk, `词轨 Wordtrail · 本页 ${segment.length} 词 · 双栏每页最多 60 词`, 18 * MM, 12 * MM, 8);
  }
  function drawAnswerCardPage(pdfDocument, fonts, plan, paper, start, sheetPageCount) {
    const page = pdfDocument.addPage(window.PDFLib.PageSizes.A4);
    const cardPage = Math.floor(start / CARDS_PER_PAGE) + 1;
    const cardPageCount = Math.max(1, Math.ceil(paper.items.length / CARDS_PER_PAGE));
    const segment = paper.items.slice(start, start + CARDS_PER_PAGE);
    drawPdfHeader(page, fonts.cjk, `${paper.label} · 错题勾选卡`, plan, sheetPageCount + cardPage);
    drawPdfText(page, fonts.cjk, `第 ${cardPage} / ${cardPageCount} 张：答错时涂满左侧圆圈；右侧圆圈留空。`, 18 * MM, 268 * MM, 8);
    [[10, 10], [200, 10], [10, 287], [200, 287]].forEach(([x, y]) => drawPdfMarker(page, x, y));
    segment.forEach((item, index) => {
      const row = Math.floor(index / 10); const column = index % 10;
      const x = 18 + column * 17.4; const y = 297 - 41 - (row + 1) * 13.5;
      page.drawRectangle({ x: x * MM, y: y * MM, width: 17.4 * MM, height: 13.5 * MM, borderColor: pdfColor('#7a919e'), borderWidth: 0.55 });
      page.drawCircle({ x: (x + 3.2) * MM, y: (y + 6.5) * MM, size: 1.7 * MM, borderColor: pdfColor('#7a919e'), borderWidth: 0.55 });
      page.drawCircle({ x: (x + 7.7) * MM, y: (y + 6.5) * MM, size: 1.7 * MM, borderColor: pdfColor('#7a919e'), borderWidth: 0.55 });
      drawPdfText(page, fonts.latin, String(item.no).padStart(3, '0'), (x + 11.2) * MM, (y + 5.1) * MM, 8);
    });
    const payload = cardPayload(plan, paper, cardPage);
    drawPdfQr(page, payload, 18 * MM, 22 * MM, 18 * MM);
    drawPdfText(page, fonts.cjk, '页面核验码：自动确认考试、周期与答题卡页码', 39 * MM, 28 * MM, 7.5);
    drawPdfText(page, fonts.latin, `WT-OMR-STATIC · ${cardPage}/${cardPageCount}`, 39 * MM, 18 * MM, 8);
  }
  async function createPdf(plan, kind, source) {
    if (!window.PDFLib || !window.fontkit) throw new Error('PDF 组件未加载，请刷新页面后重试');
    const fontBytes = await loadPdfFontBytes();
    const pdfDocument = await window.PDFLib.PDFDocument.create();
    pdfDocument.registerFontkit(window.fontkit);
    const paper = kind === 'study' ? null : source;
    const list = kind === 'study' ? source : paper.items.map((item) => item.word);
    const cjkCorpus = [plan.name, paper?.label || '', ...(kind === 'exam' ? [] : list.map((word) => word.meaning || ''))].join('');
    const commonFont = window.fontkit.create(fontBytes.cjk);
    const needsFallback = [...cjkCorpus].some((character) => !commonFont.hasGlyphForCodePoint(character.codePointAt(0)));
    const cjkBytes = needsFallback ? await loadPdfFallbackFont() : fontBytes.cjk;
    const fonts = {
      cjk: await pdfDocument.embedFont(cjkBytes, { subset: false }),
      latin: await pdfDocument.embedFont(fontBytes.latin, { subset: true })
    };
    const displayTitle = kind === 'study' ? '背诵表' : kind === 'answer' ? `${paper.label} · 答案表` : paper.label;
    pdfDocument.setTitle(`${plan.name} · ${displayTitle}`);
    pdfDocument.setAuthor('词轨 Wordtrail');
    pdfDocument.setCreator('词轨 Wordtrail 0.10');
    pdfDocument.setProducer('pdf-lib with embedded Noto fonts');
    for (let start = 0; start < Math.max(1, list.length); start += ITEMS_PER_PAGE) drawWordSheetPage(pdfDocument, fonts, plan, kind, paper, list, start);
    if (kind === 'exam') {
      const sheetPageCount = Math.max(1, Math.ceil(list.length / ITEMS_PER_PAGE));
      for (let start = 0; start < Math.max(1, paper.items.length); start += CARDS_PER_PAGE) drawAnswerCardPage(pdfDocument, fonts, plan, paper, start, sheetPageCount);
    }
    const bytes = await pdfDocument.save({ useObjectStreams: false });
    return new Blob([bytes], { type: 'application/pdf' });
  }
  function contentHash(value) { return hash(JSON.stringify(value)); }
  async function makeDocument(state, plan, kind, version) {
    const paper = kind === 'study' ? null : paperForVersion(state, plan, version); const words = paper ? paper.items : planWords(state, plan, Boolean(plan.week.frozen_word_ids?.length)); const snapshot = { kind, plan: plan.id, week: plan.week.id, version, words, template: 'static-pdf-omr-v3-60-word-double-column' }; const digest = contentHash(snapshot); const existing = state.documents.find((document) => document.content_hash === digest && document.status === 'ready'); if (existing) return existing;
    const peers = state.documents.filter((document) => document.plan_id === plan.id && document.type === kind && document.exam_version === version); const label = kind === 'study' ? '背诵表' : kind === 'answer' ? `考试表${version}_答案` : `考试表${version}`; const record = { id: newId('doc'), type: kind, label, plan_id: plan.id, week_id: plan.week.id, exam_version: version, revision: peers.length + 1, file_name: `${safeName(plan.name)}_${plan.start_week}_${label}_rev.${peers.length + 1}.pdf`, content_hash: digest, status: 'ready', created_at: now(), snapshot };
    await saveDocumentBlob(record.id, await createPdf(plan, kind, paper || words)); state.documents.unshift(record); return record;
  }

  async function publicState(state) {
    const blobs = new Map((await loadAllDocumentBlobs()).map((record) => [record.id, record.blob]));
    const documents = state.documents.map((document) => { const blob = blobs.get(document.id); let url = objectUrls.get(document.id) || ''; if (!url && blob) { url = URL.createObjectURL(blob); objectUrls.set(document.id, url); } const copy = { ...document, download_url: url, preview_url: url }; delete copy.snapshot; return copy; });
    return { wordbooks: state.wordbooks.map((book) => ({ ...book, word_count: book.words.length, matched_count: book.words.filter((word) => word.meaning_source === 'dictionary').length, unresolved_count: book.words.filter((word) => word.meaning_source === 'unresolved').length })), plans: state.plans, active_plan_id: state.active_plan_id, documents };
  }
  function parseRequestBody(options) { if (!options?.body) return {}; return typeof options.body === 'string' ? JSON.parse(options.body) : options.body; }
  async function request(pathWithQuery, options = {}) {
    const url = new URL(pathWithQuery, location.href); const path = url.pathname; const method = String(options.method || 'GET').toUpperCase(); const body = parseRequestBody(options); const state = await loadState();
    if (method === 'GET' && path === '/api/state') return publicState(state);
    if (method === 'GET' && path === '/api/dictionary/lookup') { const word = url.searchParams.get('word') || ''; const hit = (await dictionaryFor([word])).get(normal(word)); return { word, dictionary_version: DICTIONARY_VERSION, match_status: hit ? 'matched' : 'unresolved', lemma: hit?.lemma || '', phonetic: hit?.phonetic || '', part_of_speech: hit?.part_of_speech || '', display_meanings: hit?.meaning || '' }; }
    if (method === 'POST' && path === '/api/import/preview') { const [words, summary] = await preparedImport(body.filename || '', body.content || ''); return { preview: words.map(({ id, source_row, ...word }) => ({ ...word, source: source_row })), summary, dictionary_version: DICTIONARY_VERSION }; }
    if (method === 'POST' && (path === '/api/import/confirm' || path === '/api/import')) { const [words, summary] = await preparedImport(body.filename || '', body.content || '', body.selected_words); const book = { id: newId('wb'), name: String(body.name || '').trim() || String(body.filename || '').replace(/\.[^.]+$/, '') || '未命名词表', created_at: now(), words: body.shuffle ? shuffled(words) : words, dictionary_version: DICTIONARY_VERSION }; state.wordbooks.push(book); await saveState(state); return { wordbook: { id: book.id, name: book.name, word_count: book.words.length, ...summary } }; }
    const bookEdit = path.match(/^\/api\/wordbooks\/([^/]+)$/); if (method === 'POST' && bookEdit) { const book = bookFor(state, bookEdit[1]); if (String(body.name || '').trim()) book.name = String(body.name).trim(); const additions = String(body.add_words || '').split(/\r?\n/).map(extractWord).filter(Boolean); const dictionary = await dictionaryFor(additions); const known = new Set(book.words.map((word) => word.normalized_word)); for (const word of additions) if (!known.has(normal(word))) { const hit = dictionary.get(normal(word)); book.words.push({ id: newId('w'), word, meaning: hit?.meaning || '', phonetic: hit?.phonetic || '', part_of_speech: hit?.part_of_speech || '', example: '', note: '', source_row: '手动添加', normalized_word: normal(word), dictionary_lemma: hit?.lemma || '', dictionary_senses: hit ? [hit.meaning] : [], meaning_source: hit ? 'dictionary' : 'unresolved', dictionary_version: hit ? DICTIONARY_VERSION : '', match_status: hit ? 'matched' : 'unresolved' }); known.add(normal(word)); } await saveState(state); return { wordbook: book }; }
    const removeWords = path.match(/^\/api\/wordbooks\/([^/]+)\/delete-words$/); if (method === 'POST' && removeWords) { const book = bookFor(state, removeWords[1]); const removal = new Set(body.word_ids || []); const used = new Set(state.plans.filter((plan) => plan.wordbook_id === book.id).flatMap((plan) => (plan.cycles || []).flatMap((cycle) => cycle.word_ids || []))); if ([...removal].some((id) => used.has(id))) throw new Error('选中的词正在学习计划中使用；请先删除关联计划后再移除。'); const remaining = book.words.filter((word) => !removal.has(word.id)); if (!remaining.length) throw new Error('词表至少需保留 1 个词'); book.words = remaining; await saveState(state); return { ok: true }; }
    const deleteBook = path.match(/^\/api\/wordbooks\/([^/]+)\/delete$/); if (method === 'POST' && deleteBook) { const id = deleteBook[1]; if (state.plans.some((plan) => plan.wordbook_id === id)) throw new Error('此词表仍关联学习计划；请先删除计划。'); bookFor(state, id); state.wordbooks = state.wordbooks.filter((book) => book.id !== id); await saveState(state); return { ok: true }; }
    if (method === 'POST' && path === '/api/plans') { const book = bookFor(state, body.wordbook_id); const target = Number(body.weekly_target || 0); if (target < 1) throw new Error('请填写每周期至少学习 1 个词'); const plan = { id: newId('plan'), name: String(body.name || '').trim() || '未命名计划', wordbook_id: book.id, start_week: body.start_week || new Date().toISOString().slice(0, 10), weekly_target: target, estimated_cycles: estimateCycles(book.words.length, target), status: 'active', cycles: [], created_at: now() }; state.plans.push(plan); state.active_plan_id = plan.id; buildCycle(state, plan); await saveState(state); return { plan }; }
    const planEdit = path.match(/^\/api\/plans\/([^/]+)$/); if (method === 'POST' && planEdit) { const plan = planFor(state, planEdit[1]); if (String(body.name || '').trim()) plan.name = String(body.name).trim(); if (body.start_week) plan.start_week = body.start_week; if (body.weekly_target !== undefined) { const target = Number(body.weekly_target); if (target < 1) throw new Error('每周期数量至少为 1'); plan.weekly_target = target; plan.estimated_cycles = estimateCycles(bookFor(state, plan.wordbook_id).words.length, target); } await saveState(state); return { plan }; }
    const deletePlan = path.match(/^\/api\/plans\/([^/]+)\/delete$/); if (method === 'POST' && deletePlan) { const id = deletePlan[1]; planFor(state, id); state.plans = state.plans.filter((plan) => plan.id !== id); if (state.active_plan_id === id) state.active_plan_id = state.plans[0]?.id || null; await saveState(state); return { ok: true }; }
    if (method === 'POST' && path === '/api/active-plan') { planFor(state, body.plan_id); state.active_plan_id = body.plan_id; await saveState(state); return { ok: true }; }
    const planWordUpdate = path.match(/^\/api\/plans\/([^/]+)\/words$/); if (method === 'POST' && planWordUpdate) { const plan = planFor(state, planWordUpdate[1]); if (plan.week.frozen_word_ids?.length) throw new Error('周测已经生成，本周期词条已冻结'); const book = bookFor(state, plan.wordbook_id); const ids = (body.word_ids || []).filter((id) => find(book.words, id)); if (!ids.length) throw new Error('请至少保留 1 个本周期词条'); plan.week.word_ids = ids; await saveState(state); return { week: plan.week }; }
    const online = path.match(/^\/api\/exams\/(\d+)\/online$/); if (method === 'GET' && online) { const plan = planFor(state, url.searchParams.get('plan_id')); const paper = paperForVersion(state, plan, Number(online[1])); const index = Number(url.searchParams.get('index') || 0); const item = paper.items[index]; if (!item) throw new Error('题号超出范围'); let meanings = [...new Set(state.wordbooks.flatMap((book) => book.words.filter((word) => word.id !== item.word.id && word.meaning).map((word) => word.meaning)))]; if (meanings.length < 2) { const shard = await loadDictionaryShard(normal(item.word.word)[0]); meanings.push(...Object.values(shard).slice(0, 80).map((record) => record[1]).filter((meaning) => meaning && meaning !== item.word.meaning)); } const answer = item.word.meaning || '尚未补全释义'; const choices = shuffled([...new Set([answer, ...meanings])]).slice(0, 3); if (!choices.includes(answer)) choices[0] = answer; while (choices.length < 3) choices.push(answer); await saveState(state); return { paper: { version: paper.version, label: paper.label }, question: { no: item.no, word: item.word.word, choices: shuffled(choices), answer, meaning: item.word.meaning || '', phonetic: item.word.phonetic || '', part_of_speech: item.word.part_of_speech || '', examples: [`I reviewed “${item.word.word}” in today's lesson.`, `The common sense of “${item.word.word}” is: ${(item.word.meaning || 'its common meaning').split('；')[0]}.`, `Please recall “${item.word.word}” before moving on.`] }, index, total: paper.items.length }; }
    const result = path.match(/^\/api\/exams\/(\d+)\/result$/); if (method === 'POST' && result) { const plan = planFor(state, body.plan_id); const paper = plan.week.papers.find((item) => item.version === Number(result[1])); if (!paper) throw new Error('请先生成考试表'); const allowed = new Set(paper.items.map((item) => item.no)); paper.wrong_numbers = [...new Set((body.wrong_numbers || []).map(Number).filter((number) => allowed.has(number)))].sort((a, b) => a - b); paper.result_at = now(); let grade = ''; if (paper.version === 2) { grade = gradeCycle(plan.week); plan.week.grade = grade; plan.week.status = 'completed'; if (!buildCycle(state, plan)) plan.status = 'completed'; } await saveState(state); return { paper, grade, next_cycle: grade ? plan.week.number : null }; }
    const scan = path.match(/^\/api\/exams\/(\d+)\/scan$/); if (method === 'POST' && scan) { const plan = planFor(state, body.plan_id); const paper = plan.week.papers.find((item) => item.version === Number(scan[1])); if (!paper) throw new Error('请先生成周测或复测'); if (!window.WordtrailOMR) throw new Error('浏览器识别组件未加载'); return window.WordtrailOMR.scan(body.image, { plan_id: plan.id, week_id: plan.week.id, paper_id: paper.id, version: paper.version, item_count: paper.items.length }); }
    if (method === 'POST' && path === '/api/documents/generate') { const plan = planFor(state, body.plan_id); const kind = body.type; let version = body.exam_version ?? body.version; if (!['study', 'exam', 'answer'].includes(kind)) throw new Error('未知文档类型'); if (kind === 'study') version = null; else { version = Number(version || 1); if (![1, 2].includes(version)) throw new Error('每周期仅支持周测和复测'); } const document = await makeDocument(state, plan, kind, version); await saveState(state); const publicData = await publicState(state); return { document: find(publicData.documents, document.id) }; }
    throw new Error('接口不存在');
  }

  async function exportBackup() {
    const state = await loadState(); const docs = await loadAllDocumentBlobs(); const documents = [];
    for (const item of docs) { const bytes = new Uint8Array(await item.blob.arrayBuffer()); let binary = ''; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); documents.push({ id: item.id, type: item.blob.type, data: btoa(binary) }); }
    return new Blob([JSON.stringify({ format: 'wordtrail-backup', version: 1, exported_at: now(), state, documents })], { type: 'application/json' });
  }
  async function importBackup(file) {
    let backup; try { backup = JSON.parse(await file.text()); } catch { throw new Error('备份文件不是有效 JSON'); }
    if (backup?.format !== 'wordtrail-backup' || backup.version !== 1 || !backup.state) throw new Error('这不是词轨完整备份文件');
    const db = await openDatabase(); await new Promise((resolve, reject) => { const tx = db.transaction(['state', 'documents'], 'readwrite'); tx.objectStore('state').clear(); tx.objectStore('documents').clear(); tx.objectStore('state').put(backup.state, 'main'); for (const item of backup.documents || []) { const binary = atob(item.data); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); tx.objectStore('documents').put({ id: item.id, blob: new Blob([bytes], { type: item.type || 'application/pdf' }) }); } tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    for (const url of objectUrls.values()) URL.revokeObjectURL(url); objectUrls.clear();
  }
  async function requestPersistentStorage() { try { if (navigator.storage?.persist) return navigator.storage.persist(); } catch {} return false; }
  window.WordtrailService = { request, exportBackup, importBackup, requestPersistentStorage, templateBlob: () => new Blob(['\ufeffword\nresilient\nabandon 放弃\nbenefit,好处\n'], { type: 'text/csv;charset=utf-8' }), __test: { loadState, saveState, createPdf, cardPayload, hash } };
})();
