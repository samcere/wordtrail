(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const PAGE_SIZE = 20;
  const draftStore = 'wordtrail-quiz-drafts-v2';
  const paperStore = 'wordtrail-paper-drafts-v2';
  const assets = new Map();
  let state, mode = 'study', busy = false, toastTimer;
  let studyPage = 0, studyQuery = '', covered = false, revealed = new Set(), expanded = new Set(), studyKey = '';
  let setupBookId = '', importData = null, importToken = 0;
  let quiz = null, paperOpen = false, paperKey = '', wrong = new Set(), errorPage = 0, errorQuery = '';
  let historyPage = 0, bookPage = 0, bookQuery = '', bookSelection = new Set(), scanContext;

  const plan = () => state?.plans.find(item => item.id === state.active_plan_id) || state?.plans[0];
  const book = (id) => state?.wordbooks.find(item => item.id === (id || plan()?.wordbook_id));
  const currentWords = () => {
    const current = plan();
    const ids = current?.week.frozen_word_ids?.length ? current.week.frozen_word_ids : current?.week.word_ids || [];
    const lookup = new Map((book()?.words || []).map(word => [word.id, word]));
    return ids.map(id => lookup.get(id)).filter(Boolean);
  };
  const version = () => plan()?.week.papers.some(paper => paper.version === 1 && paper.result_at) ? 2 : 1;
  const paper = () => plan()?.week.papers.find(item => item.version === version());
  const sessionKey = () => `${plan()?.id}:${plan()?.week.id}:${version()}`;
  const post = (path, body) => WordtrailService.request(path, { method: 'POST', body: JSON.stringify(body) });
  const localDate = () => new Date().toLocaleDateString('en-CA');

  function notify(text, error = false) {
    const target = $('#toast');
    target.textContent = text;
    target.classList.toggle('error', error);
    target.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { target.hidden = true; }, error ? 6500 : 4200);
  }
  function fieldError(id, message = '') {
    const target = $(id);
    target.textContent = message;
    target.hidden = !message;
  }
  async function run(button, label, action) {
    if (window.Workbench?.dataBusy) { notify('正在处理备份，请稍候。'); return; }
    if (busy) { notify('正在处理，请稍候。'); return; }
    busy = true;
    const changesLabel = button?.tagName === 'BUTTON';
    const original = button?.innerHTML;
    if (button) { button.disabled = true; if (changesLabel) button.textContent = label; button.setAttribute('aria-busy', 'true'); }
    try { await action(); }
    catch (error) { notify(error.message || '操作未完成，请重试。', true); }
    finally {
      busy = false;
      if (button?.isConnected) { button.disabled = false; if (changesLabel) button.innerHTML = original; button.removeAttribute('aria-busy'); }
    }
  }
  function loadScript(name) {
    if (!assets.has(name)) assets.set(name, new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = name;
      script.onload = resolve;
      script.onerror = () => { script.remove(); assets.delete(name); reject(new Error('组件下载失败，请联网后重试。')); };
      document.head.append(script);
    }));
    return assets.get(name);
  }
  async function pdfAssets() {
    await Promise.all([loadScript('vendor/pdf-lib.min.js'), loadScript('vendor/fontkit.umd.min.js'), loadScript('vendor/qrcode.js')]);
  }
  function readStore(key) { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } }
  function writeStore(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { notify('浏览器无法保存答题草稿，请勿关闭页面。', true); } }
  function setDraft(key, value, storage = draftStore) {
    const all = readStore(storage);
    if (value === null) delete all[key]; else all[key] = value;
    writeStore(storage, all);
  }
  function persistedQuiz() {
    const draft = readStore(draftStore)[sessionKey()];
    const current = paper();
    return draft && current && !current.result_at && draft.paperId === current.id && draft.index < current.items.length ? draft : null;
  }
  function showDialog(id) {
    $$('dialog[open]').forEach(dialog => dialog.close());
    $(id).showModal();
  }
  function paginate(id, page, count, size, action) {
    const pages = Math.max(1, Math.ceil(count / size));
    $(id).innerHTML = pages <= 1 ? '' : `<button type="button" data-action="${action}" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page + 1} / ${pages}</span><button type="button" data-action="${action}" data-page="${page + 1}" ${page >= pages - 1 ? 'disabled' : ''}>下一页</button>`;
  }
  async function refresh() {
    state = await WordtrailService.request('/api/state');
    render();
  }
  function setMode(next, updateHash = true) {
    mode = next === 'test' ? 'test' : 'study';
    for (const item of ['study', 'test']) {
      const active = mode === item;
      $(`#${item}-tab`).setAttribute('aria-selected', String(active));
      $(`#${item}-tab`).tabIndex = active ? 0 : -1;
      $(`#${item}-panel`).hidden = !active;
    }
    if (updateHash && location.hash !== `#${mode === 'test' ? 'test' : 'learn'}`) location.hash = mode === 'test' ? 'test' : 'learn';
    render();
  }
  function render() {
    const current = plan();
    $('#empty').classList.toggle('hidden', !!current);
    $('#learning').classList.toggle('hidden', !current);
    $('#header-import').classList.toggle('hidden', !current);
    $('#existing-start').hidden = !state.wordbooks.length;
    renderManage();
    renderHistory();
    if (!current) return;
    const key = `${current.id}:${current.week.id}`;
    if (studyKey !== key) {
      studyKey = key; studyPage = 0; studyQuery = ''; revealed.clear(); expanded.clear(); quiz = null;
      $('#study-search').value = ''; paperOpen = false;
    }
    $('#plan-select').innerHTML = state.plans.map(item => `<option value="${item.id}" ${item.id === current.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('');
    const completed = current.cycles.filter(cycle => cycle.grade).length;
    $('#plan-meta').textContent = `每周 ${current.weekly_target} 词 · 已完成 ${completed} 周`;
    $('#cycle-label').textContent = current.status === 'completed' ? '已学完' : `第 ${current.week.number} 周`;
    const stage = current.status === 'completed' ? 3 : version() === 2 ? 2 : current.week.papers.length || mode === 'test' ? 1 : 0;
    $('#steps').innerHTML = ['背词', '周测', '复测'].map((label, index) => `<li class="${index < stage ? 'done' : index === stage ? 'current' : ''}" ${index === stage ? 'aria-current="step"' : ''}><span class="step-dot" aria-hidden="true">${index < stage ? '✓' : index + 1}</span>${label}</li>`).join('');
    const last = [...current.cycles].reverse().find(cycle => cycle.grade);
    $('#last-result').classList.toggle('hidden', !last);
    if (last) $('#last-result').textContent = `第 ${last.number} 周已完成 · ${last.grade} / ${last.score} 分${current.status !== 'completed' ? '，本周单词已准备好。' : '，整个计划已学完。'}`;
    renderStudy();
    renderTest();
  }
  function renderStudy() {
    const list = currentWords();
    $('#word-count').textContent = `本周 ${list.length} 个词`;
    $('#meaning-toggle').textContent = covered ? '显示释义' : '遮住释义';
    $('#meaning-toggle').setAttribute('aria-pressed', String(covered));
    const matches = list.map((word, index) => ({ word, no: index + 1 })).filter(({ word }) => word.word.toLowerCase().includes(studyQuery));
    studyPage = Math.min(studyPage, Math.max(0, Math.ceil(matches.length / PAGE_SIZE) - 1));
    $('#word-list').innerHTML = matches.slice(studyPage * PAGE_SIZE, (studyPage + 1) * PAGE_SIZE).map(({ word, no }) => {
      const hidden = covered && !revealed.has(word.id);
      return `<div class="word-row"><span class="word-no">${String(no).padStart(2, '0')}</span><span class="word-en">${esc(word.word)}</span><button type="button" class="meaning ${hidden ? 'covered' : ''} ${expanded.has(word.id) || covered && !hidden ? 'expanded' : ''}" data-action="reveal" data-id="${word.id}" aria-label="${hidden ? '显示' : covered ? '隐藏' : expanded.has(word.id) ? '收起' : '展开'} ${esc(word.word)} 的释义" aria-expanded="${expanded.has(word.id) || covered && !hidden}">${hidden ? '点击查看释义' : esc(word.meaning || '词典暂未收录')}</button></div>`;
    }).join('') || '<p class="no-results">没有找到这个单词。</p>';
    paginate('#study-pagination', studyPage, matches.length, PAGE_SIZE, 'study-page');
    $('#study-next').innerHTML = plan().status === 'completed' ? '' : `<button type="button" class="primary" data-action="test">${version() === 1 ? '背好了，开始周测' : '进入复测'} <span aria-hidden="true">→</span></button>`;
  }
  function renderTest() {
    const current = plan();
    if (!current) return;
    if (quiz) { renderQuiz(); return; }
    const currentPaper = paper(), currentVersion = version();
    const label = currentVersion === 1 ? '周测' : '复测';
    $('#test-tab').textContent = current.status === 'completed' ? '学习结果' : label;
    if (current.status === 'completed') {
      $('#test-content').innerHTML = `<div class="test-overview"><h2>计划已完成</h2><p>共完成 ${current.cycles.length} 周学习。最后一周 ${current.week.grade} / ${current.week.score} 分。</p><button type="button" class="primary" data-action="setup">导入词表</button></div>`;
      return;
    }
    const key = currentPaper?.id || '';
    if (paperKey !== key) {
      paperKey = key; errorPage = 0; errorQuery = '';
      const stored = readStore(paperStore)[key] || [];
      const allowed = new Set(currentPaper?.items.map(item => item.no) || []);
      wrong = new Set(stored.filter(no => allowed.has(no)));
    }
    const draft = persistedQuiz();
    const first = current.week.papers.find(item => item.version === 1);
    const count = currentPaper?.items.length || currentWords().length;
    const description = currentVersion === 1 ? `测一测本周的 ${count} 个词。选出中文释义，答错的词自动进入复测。` : `周测错了 ${first.wrong_numbers.length} 词。复测会加入全部错词和 20% 的正确词，再打乱顺序。`;
    $('#test-content').innerHTML = `<div class="test-overview"><h2>${label}${currentPaper ? ` · ${currentPaper.items.length} 词` : ''}</h2><p>${description}</p><button type="button" class="primary" data-action="start-quiz">${draft ? `继续答题 · 第 ${draft.index + 1} 题` : `开始${label}`} <span aria-hidden="true">→</span></button></div><details id="paper-mode" class="paper-mode" ${paperOpen ? 'open' : ''}><summary>使用纸面测试</summary><div class="paper-actions"><button type="button" class="secondary" data-action="exam-pdf">下载试卷</button>${currentPaper ? '<button type="button" class="quiet" data-action="answer-pdf">下载答案</button><button type="button" class="quiet" data-action="scan">上传涂卡照片</button>' : ''}</div><p class="caption">试卷每页 60 词、双栏。错题卡独立成页，每页最多 300 题。</p>${currentPaper ? `<form id="result-form" class="result-form"><h3>登记纸面错词</h3><p class="caption">输入错题号，或直接勾选。全部答对可直接提交。</p><label class="sr-only" for="error-batch">批量输入错题号</label><div class="batch-row"><input id="error-batch" placeholder="例如 1, 3, 8-10" autocomplete="off"><button type="button" class="secondary" data-action="add-errors">添加</button></div><label class="sr-only" for="error-search">查找错题单词或题号</label><input id="error-search" type="search" class="full" placeholder="查找单词或题号" value="${esc(errorQuery)}"><div class="error-summary"><strong id="error-count" aria-live="polite"></strong><button type="button" class="text" data-action="clear-errors">清空</button></div><div id="error-grid" class="error-grid"></div><div id="error-pagination" class="pagination"></div><p id="result-error" class="inline-error" role="alert" hidden></p><button type="submit" class="primary full">提交${label}结果</button></form>` : ''}</details>`;
    if (currentPaper) renderErrors();
  }
  function renderErrors() {
    const current = paper();
    if (!current || !$('#error-grid')) return;
    const matches = current.items.filter(item => item.word.word.toLowerCase().includes(errorQuery) || String(item.no) === errorQuery);
    errorPage = Math.min(errorPage, Math.max(0, Math.ceil(matches.length / 60) - 1));
    $('#error-grid').innerHTML = matches.slice(errorPage * 60, (errorPage + 1) * 60).map(item => `<label class="error-choice"><input type="checkbox" value="${item.no}" ${wrong.has(item.no) ? 'checked' : ''}><span>${String(item.no).padStart(3, '0')} ${esc(item.word.word)}</span></label>`).join('') || '<p class="no-results">没有找到匹配的题目。</p>';
    $('#error-count').textContent = `已选 ${wrong.size} / ${current.items.length} 个错词`;
    paginate('#error-pagination', errorPage, matches.length, 60, 'error-page');
  }
  function savePaperDraft() { if (paper()) setDraft(paper().id, [...wrong], paperStore); }
  function addErrors() {
    const raw = $('#error-batch').value.trim();
    if (!raw) { fieldError('#result-error', '请输入错题号，例如 1, 3, 8-10。'); return; }
    const numbers = new Set();
    for (const token of raw.split(/[,，、;；\s]+/).filter(Boolean)) {
      if (!/^\d+(?:[-~～—–]\d+)?$/.test(token)) { fieldError('#result-error', `无法识别「${token}」，请使用题号或题号范围。`); return; }
      const [first, last = first] = token.split(/[-~～—–]/).map(Number);
      if (Math.min(first, last) < 1 || Math.max(first, last) > paper().items.length) { fieldError('#result-error', `题号应在 1 到 ${paper().items.length} 之间。`); return; }
      for (let number = Math.min(first, last); number <= Math.max(first, last); number++) numbers.add(number);
    }
    numbers.forEach(number => wrong.add(number));
    fieldError('#result-error'); $('#error-batch').value = ''; savePaperDraft(); renderErrors();
  }
  async function generate(kind, button) {
    paperOpen ||= kind !== 'study';
    await run(button, '正在生成…', async () => {
      await pdfAssets();
      const result = await post('/api/documents/generate', { plan_id: plan().id, type: kind, exam_version: kind === 'study' ? null : version() });
      download(result.document.download_url, result.document.file_name);
      await refresh();
      notify('PDF 已保存到下载记录，并开始下载。');
    });
  }
  function download(url, name) {
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
  }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob); download(url, name); setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function renderHistory() {
    const docs = state.documents;
    $('#history').hidden = !docs.length;
    $('#history-count').textContent = `${docs.length} 份`;
    historyPage = Math.min(historyPage, Math.max(0, Math.ceil(docs.length / 8) - 1));
    $('#history-list').innerHTML = docs.slice(historyPage * 8, (historyPage + 1) * 8).map(doc => {
      const current = state.plans.find(item => item.id === doc.plan_id);
      return `<div class="history-row"><div><strong>${esc(doc.label)} · 第 ${doc.revision} 版</strong><p>${esc(current?.name || '已删除的计划')} · ${esc(doc.created_at)}</p></div><div class="history-actions">${doc.download_url ? `<a href="${esc(doc.preview_url)}" target="_blank" rel="noopener" aria-label="预览 ${esc(doc.file_name)}">预览</a><a href="${esc(doc.download_url)}" download="${esc(doc.file_name)}" aria-label="下载 ${esc(doc.file_name)}">下载 ↓</a>` : '<span class="caption">文件不可用</span>'}</div></div>`;
    }).join('');
    paginate('#history-pagination', historyPage, docs.length, 8, 'history-page');
  }
  async function startQuiz(button) {
    await run(button, '正在准备…', async () => {
      quiz = persistedQuiz();
      if (!quiz) {
        const response = await WordtrailService.request(`/api/exams/${version()}/online?plan_id=${plan().id}&index=0`);
        await refresh();
        quiz = { key: sessionKey(), planId: plan().id, weekId: plan().week.id, paperId: paper().id, version: version(), index: 0, total: response.total, question: response.question, wrong: [], answered: false, choice: null };
        setDraft(quiz.key, quiz);
      }
      renderQuiz();
    });
  }
  function renderQuiz() {
    if (!quiz) return;
    const question = quiz.question;
    const correct = quiz.answered && quiz.choice !== -1 && question.choices[quiz.choice] === question.answer;
    $('#test-content').innerHTML = `<div class="quiz-head"><span>${quiz.version === 1 ? '周测' : '复测'} · 第 ${quiz.index + 1} / ${quiz.total} 题</span><button type="button" class="quiet" data-action="pause-quiz">暂停</button></div><progress aria-label="答题进度" value="${quiz.index + (quiz.answered ? 1 : 0)}" max="${quiz.total}"></progress><h2 class="quiz-word">${esc(question.word)}</h2><p class="quiz-prompt">选择最符合的中文释义</p><div class="quiz-options">${question.choices.map((choice, index) => `<button type="button" class="quiz-option ${quiz.answered && choice === question.answer ? 'correct' : quiz.answered && quiz.choice === index ? 'wrong' : ''}" data-action="answer" data-choice="${index}" ${quiz.answered ? 'disabled' : ''}><span>${quiz.answered && choice === question.answer ? '✓' : String.fromCharCode(65 + index)}</span><span>${esc(choice)}</span></button>`).join('')}</div>${quiz.answered ? `<div class="quiz-feedback" role="status"><strong>${correct ? '回答正确' : '已记为错词'}</strong><p>${esc(question.meaning || '词典暂未收录，建议纸面自测。')}</p></div><div class="quiz-footer"><button type="button" class="primary full" data-action="next-question">${quiz.index + 1 === quiz.total ? '完成并保存结果' : '下一题 →'}</button></div>` : '<div class="quiz-footer"><button type="button" class="text" data-action="answer" data-choice="-1">不认识，记为错词</button></div>'}`;
    if (quiz.answered) $('[data-action="next-question"]').focus({ preventScroll: true });
  }
  function answerQuiz(index) {
    if (!quiz || quiz.answered || busy) return;
    quiz.answered = true; quiz.choice = index;
    if (index === -1 || quiz.question.choices[index] !== quiz.question.answer) quiz.wrong.push(quiz.question.no);
    setDraft(quiz.key, quiz); renderQuiz();
  }
  async function nextQuestion(button) {
    if (!quiz?.answered) return;
    await run(button, '正在保存…', async () => {
      if (quiz.index + 1 < quiz.total) {
        const response = await WordtrailService.request(`/api/exams/${quiz.version}/online?plan_id=${quiz.planId}&index=${quiz.index + 1}`);
        quiz.index++; quiz.question = response.question; quiz.answered = false; quiz.choice = null;
        setDraft(quiz.key, quiz); renderQuiz();
      } else {
        const submitted = quiz;
        const result = await post(`/api/exams/${quiz.version}/result`, { plan_id: quiz.planId, paper_id: quiz.paperId, wrong_numbers: quiz.wrong });
        setDraft(submitted.key, null); setDraft(submitted.paperId, null, paperStore); quiz = null;
        await refresh();
        if (result.grade) setMode(plan().status === 'completed' ? 'test' : 'study');
        notify(result.grade ? `本周完成，评级 ${result.grade}。` : `周测已保存，错 ${submitted.wrong.length} 词，接下来复测。`);
      }
    });
  }
  function renderManage() {
    $('#manage-books').innerHTML = state.wordbooks.map(item => `<div class="manage-row"><div><strong>${esc(item.name)}</strong><p>${item.word_count} 个词</p></div><div class="inline-actions"><button type="button" class="quiet" data-action="edit-book" data-id="${item.id}">编辑</button><button type="button" class="text" data-action="book-plan" data-id="${item.id}">开始学习</button></div></div>`).join('') || '<p class="caption">还没有词表。</p>';
    $('#manage-plans').innerHTML = state.plans.map(item => `<div class="manage-row"><div><strong>${esc(item.name)}</strong><p>${item.status === 'completed' ? '已学完' : `第 ${item.week.number} 周`} · 每周 ${item.weekly_target} 词</p></div><div class="inline-actions"><button type="button" class="quiet" data-action="edit-plan" data-id="${item.id}">编辑</button>${item.id === plan()?.id ? '<span class="caption">当前</span>' : `<button type="button" class="text" data-action="activate" data-id="${item.id}">使用</button>`}</div></div>`).join('') || '<p class="caption">导入词表时会一起创建计划。</p>';
  }
  function openSetup(id = '') {
    importToken++; setupBookId = id; importData = null;
    $('#setup-form').reset(); fieldError('#setup-error');
    $('#file-label').textContent = '选择单词文件'; $('#import-status').hidden = true; $('#import-preview').hidden = true; $('#import-preview').open = false;
    $('#setup-file-area').hidden = !!id; $('#setup-existing').hidden = !id; $('#shuffle-label').hidden = !!id;
    $('#setup-title').textContent = id ? '设置学习节奏' : '导入并开始学习';
    if (id) $('#setup-existing').textContent = `${book(id).name} · ${book(id).word_count} 个词`;
    $('#setup-submit').disabled = !id; estimate(); showDialog('#setup-dialog');
  }
  function estimate() {
    const total = setupBookId ? book(setupBookId)?.word_count : importData?.preview.length;
    const target = Number($('#setup-target').value);
    if (!total || !Number.isInteger(target) || target < 1) { $('#setup-estimate').textContent = '从第二周起，会穿插约 10% 的旧词复习。'; return; }
    const count = total <= target ? 1 : 1 + Math.ceil((total - target) / Math.max(1, target - Math.max(1, Math.round(target * .1))));
    $('#setup-estimate').textContent = `共 ${total} 词，预计 ${count} 周学完；第二周起穿插旧词复习。`;
  }
  const fileData = file => new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取文件，请重新选择。')); reader.readAsDataURL(file);
  });
  async function previewImport(file) {
    const token = ++importToken;
    importData = null; $('#setup-submit').disabled = true; $('#import-preview').hidden = true; fieldError('#setup-error');
    if (!file) { $('#file-label').textContent = '选择单词文件'; $('#import-status').hidden = true; return; }
    $('#file-label').textContent = file.name; $('#import-status').hidden = false; $('#import-status').textContent = '正在识别单词并补全释义…'; $('#import-status').classList.remove('error');
    try {
      if (/\.xlsx?$/i.test(file.name)) await loadScript('vendor/xlsx.full.min.js');
      const content = await fileData(file);
      const response = await post('/api/import/preview', { filename: file.name, content });
      if (token !== importToken) return;
      if (!response.preview.length) throw new Error('没有识别出英文单词，请检查文件内容。');
      importData = { filename: file.name, content, preview: response.preview };
      $('#import-status').textContent = `识别 ${response.preview.length} 词 · ${response.summary.matched_count} 词已补全释义${response.summary.unresolved_count ? ` · ${response.summary.unresolved_count} 词暂未收录` : ''}`;
      $('#preview-count').textContent = `· ${response.preview.length} 词`;
      $('#preview-list').innerHTML = response.preview.slice(0, 60).map(item => `<div class="preview-row"><span>${esc(item.word)}</span><span>${esc(item.meaning || '词典暂未收录')}</span></div>`).join('') + (response.preview.length > 60 ? '<p class="caption">此处预览前 60 词，导入后可在管理中查看全部。</p>' : '');
      $('#import-preview').hidden = false; $('#setup-submit').disabled = false; estimate();
    } catch (error) {
      if (token !== importToken) return;
      $('#import-status').textContent = error.message; $('#import-status').classList.add('error');
    }
  }
  async function submitSetup(button) {
    const target = Number($('#setup-target').value);
    if (!Number.isInteger(target) || target < 1) { fieldError('#setup-error', '每周数量应为大于 0 的整数。'); return; }
    if (!setupBookId && !importData) { fieldError('#setup-error', '请先选择并识别词表文件。'); return; }
    await run(button, '正在准备学习…', async () => {
      try {
        const name = $('#setup-name').value.trim() || (setupBookId ? book(setupBookId).name : importData.filename.replace(/\.[^.]+$/, ''));
        if (setupBookId) await post('/api/plans', { wordbook_id: setupBookId, name, weekly_target: target, start_week: localDate() });
        else await post('/api/setup', { filename: importData.filename, content: importData.content, name, weekly_target: target, start_week: localDate(), shuffle: $('#setup-shuffle').checked });
        $('#setup-dialog').close(); await refresh(); setMode('study'); notify('词表和计划已创建。');
      } catch (error) { fieldError('#setup-error', error.message); }
    });
  }
  function editPlan(id) {
    const current = state.plans.find(item => item.id === id);
    $('#edit-plan-id').value = id; $('#edit-plan-name').value = current.name; $('#edit-plan-target').value = current.weekly_target;
    fieldError('#plan-error'); showDialog('#plan-dialog');
  }
  function editBook(id) {
    $('#edit-book-id').value = id; $('#edit-book-name').value = book(id).name; $('#book-add').value = ''; $('#book-search').value = '';
    bookPage = 0; bookQuery = ''; bookSelection.clear(); fieldError('#book-error'); renderBookWords(); showDialog('#book-dialog');
  }
  function renderBookWords() {
    const id = $('#edit-book-id').value, current = book(id);
    if (!current) return;
    const used = new Set(state.plans.filter(item => item.wordbook_id === id).flatMap(item => item.cycles.flatMap(cycle => cycle.word_ids)));
    const matches = current.words.filter(word => word.word.toLowerCase().includes(bookQuery));
    bookPage = Math.min(bookPage, Math.max(0, Math.ceil(matches.length / 40) - 1));
    $('#book-words').innerHTML = matches.slice(bookPage * 40, (bookPage + 1) * 40).map(word => `<label class="book-word"><input type="checkbox" value="${word.id}" ${bookSelection.has(word.id) ? 'checked' : ''} ${used.has(word.id) ? 'disabled' : ''} aria-label="选择 ${esc(word.word)}"><span>${esc(word.word)}</span><span>${esc(word.meaning || '词典暂未收录')}</span></label>`).join('') || '<p class="no-results">没有找到匹配的单词。</p>';
    $('#book-selection').textContent = `${matches.length} 词 · 已选 ${bookSelection.size} 词`;
    $('#delete-words').disabled = !bookSelection.size;
    paginate('#book-pagination', bookPage, matches.length, 40, 'book-page');
  }
  async function activate(id, button) {
    await run(button, '切换中…', async () => { await post('/api/active-plan', { plan_id: id }); quiz = null; await refresh(); setMode('study'); $$('dialog[open]').forEach(dialog => dialog.close()); });
  }
  async function scan(file, button) {
    if (!file || !scanContext) return;
    const context = scanContext;
    await run(button, '正在识别…', async () => {
      if (context.weekId !== plan()?.week.id || context.paperId !== paper()?.id) throw new Error('当前试卷已经改变，请重新选择照片。');
      await Promise.all([loadScript('vendor/jsQR.js'), loadScript('omr.js')]);
      notify('正在识别照片，首次使用可能稍慢。');
      const response = await post(`/api/exams/${context.version}/scan`, { plan_id: context.planId, image: await fileData(file) });
      response.suggested_wrong_numbers.forEach(number => wrong.add(number));
      savePaperDraft(); paperOpen = true; renderTest(); notify(`已识别并选中 ${response.suggested_wrong_numbers.length} 个错词，请核对后提交。`);
    });
    $('#scan-file').value = '';
  }

  document.addEventListener('click', async event => {
    if (event.target.closest('[data-close]')) { event.target.closest('dialog').close(); return; }
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled || !state) return;
    const id = button.dataset.id;
    switch (button.dataset.action) {
      case 'manage': renderManage(); showDialog('#manage-dialog'); break;
      case 'setup': openSetup(); break;
      case 'book-plan': openSetup(id); break;
      case 'study': setMode('study'); break;
      case 'test': setMode('test'); break;
      case 'toggle-meaning': covered = !covered; revealed.clear(); renderStudy(); break;
      case 'reveal': { const collection = covered ? revealed : expanded; if (collection.has(id)) collection.delete(id); else collection.add(id); renderStudy(); break; }
      case 'study-page': studyPage = Number(button.dataset.page); renderStudy(); break;
      case 'history-page': historyPage = Number(button.dataset.page); renderHistory(); break;
      case 'study-pdf': await generate('study', button); break;
      case 'exam-pdf': await generate('exam', button); break;
      case 'answer-pdf': await generate('answer', button); break;
      case 'start-quiz': await startQuiz(button); break;
      case 'answer': answerQuiz(Number(button.dataset.choice)); break;
      case 'next-question': await nextQuestion(button); break;
      case 'pause-quiz': quiz = null; renderTest(); notify('答题进度已保存，可随时继续。'); break;
      case 'add-errors': addErrors(); break;
      case 'clear-errors': wrong.clear(); savePaperDraft(); renderErrors(); break;
      case 'error-page': errorPage = Number(button.dataset.page); renderErrors(); break;
      case 'scan': scanContext = { planId: plan().id, weekId: plan().week.id, paperId: paper().id, version: version() }; $('#scan-file').click(); break;
      case 'edit-current': editPlan(plan().id); break;
      case 'edit-plan': editPlan(id); break;
      case 'edit-book': editBook(id); break;
      case 'activate': await activate(id, button); break;
      case 'book-page': bookPage = Number(button.dataset.page); renderBookWords(); break;
      case 'delete-words': {
        if (!bookSelection.size || !confirm(`删除选中的 ${bookSelection.size} 个词？`)) break;
        await run(button, '正在删除…', async () => { try { await post(`/api/wordbooks/${$('#edit-book-id').value}/delete-words`, { word_ids: [...bookSelection] }); bookSelection.clear(); await refresh(); renderBookWords(); notify('选中词已删除。'); } catch (error) { fieldError('#book-error', error.message); } }); break;
      }
      case 'delete-book': {
        if (!confirm(`删除词表「${book($('#edit-book-id').value).name}」？有关联计划时需要先删除计划。`)) break;
        await run(button, '正在删除…', async () => { try { await post(`/api/wordbooks/${$('#edit-book-id').value}/delete`, {}); $('#book-dialog').close(); await refresh(); } catch (error) { fieldError('#book-error', error.message); } }); break;
      }
      case 'delete-plan': {
        if (!confirm('删除这个学习计划？词表和已生成的 PDF 会保留。')) break;
        await run(button, '正在删除…', async () => { await post(`/api/plans/${$('#edit-plan-id').value}/delete`, {}); $('#plan-dialog').close(); quiz = null; await refresh(); setMode('study'); }); break;
      }
      case 'backup': await run(button, '正在整理…', async () => { downloadBlob(await WordtrailService.exportBackup(), `词轨备份_${localDate()}.json`); notify('完整备份已开始下载。'); }); break;
      case 'restore': $('#backup-file').click(); break;
    }
  });
  document.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target, button = form.querySelector('button[type="submit"]');
    if (form.id === 'setup-form') { await submitSetup(button); return; }
    if (form.id === 'plan-form') {
      await run(button, '正在保存…', async () => { try { await post(`/api/plans/${$('#edit-plan-id').value}`, { name: $('#edit-plan-name').value.trim(), weekly_target: Number($('#edit-plan-target').value) }); $('#plan-dialog').close(); await refresh(); notify('计划已保存。'); } catch (error) { fieldError('#plan-error', error.message); } });
    } else if (form.id === 'book-form') {
      await run(button, '正在保存…', async () => { try { await post(`/api/wordbooks/${$('#edit-book-id').value}`, { name: $('#edit-book-name').value.trim(), add_words: $('#book-add').value }); $('#book-add').value = ''; await refresh(); renderBookWords(); fieldError('#book-error'); notify('词表已保存。'); } catch (error) { fieldError('#book-error', error.message); } });
    } else if (form.id === 'result-form') {
      const draft = persistedQuiz();
      if (!confirm(`提交${version() === 1 ? '周测' : '复测'}结果？已选 ${wrong.size} / ${paper().items.length} 个错词。${draft ? '\n未完成的在线答题进度将被这份结果替换。' : ''}`)) return;
      await run(button, '正在保存…', async () => {
        try {
          const key = sessionKey(), paperId = paper().id;
          const result = await post(`/api/exams/${version()}/result`, { plan_id: plan().id, paper_id: paperId, wrong_numbers: [...wrong] });
          setDraft(key, null); setDraft(paperId, null, paperStore); quiz = null; await refresh();
          if (result.grade) setMode(plan().status === 'completed' ? 'test' : 'study');
          notify(result.grade ? `本周完成，评级 ${result.grade}。` : '周测结果已保存，可以开始复测。');
        } catch (error) { fieldError('#result-error', error.message); }
      });
    }
  });
  document.addEventListener('input', event => {
    const input = event.target;
    if (input.id === 'study-search') { studyQuery = input.value.trim().toLowerCase(); studyPage = 0; renderStudy(); }
    if (input.id === 'book-search') { bookQuery = input.value.trim().toLowerCase(); bookPage = 0; renderBookWords(); }
    if (input.id === 'error-search') { errorQuery = input.value.trim().toLowerCase(); errorPage = 0; renderErrors(); }
    if (input.id === 'setup-target') estimate();
  });
  document.addEventListener('change', async event => {
    const input = event.target;
    if (input.id === 'plan-select') await activate(input.value, input);
    if (input.id === 'import-file') await previewImport(input.files[0]);
    if (input.matches('#error-grid input')) { if (input.checked) wrong.add(Number(input.value)); else wrong.delete(Number(input.value)); savePaperDraft(); $('#error-count').textContent = `已选 ${wrong.size} / ${paper().items.length} 个错词`; }
    if (input.matches('#book-words input')) { if (input.checked) bookSelection.add(input.value); else bookSelection.delete(input.value); $('#book-selection').textContent = `${book($('#edit-book-id').value).word_count} 词 · 已选 ${bookSelection.size} 词`; $('#delete-words').disabled = !bookSelection.size; }
    if (input.id === 'scan-file') await scan(input.files[0], $('[data-action="scan"]'));
    if (input.id === 'backup-file' && input.files[0]) {
      const file = input.files[0]; input.value = '';
      if (!confirm('恢复备份会替换当前词表、计划、进度和 PDF，确定继续？')) return;
      await run(null, '', async () => { await WordtrailService.importBackup(file); writeStore(draftStore, {}); writeStore(paperStore, {}); quiz = null; paperKey = ''; await refresh(); $$('dialog[open]').forEach(dialog => dialog.close()); setMode('study'); notify('备份已恢复。'); });
    }
  });
  document.addEventListener('toggle', event => { if (event.target.id === 'paper-mode' && event.target.isConnected) paperOpen = event.target.open; }, true);
  document.addEventListener('keydown', event => {
    if (event.target.closest('[role="tablist"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setMode(event.key === 'Home' ? 'study' : event.key === 'End' ? 'test' : mode === 'study' ? 'test' : 'study'); $(`#${mode}-tab`).focus(); }
    if (event.target.id === 'error-batch' && event.key === 'Enter') { event.preventDefault(); addErrors(); }
  });
  window.addEventListener('hashchange', () => { if (state && ['#learn', '#words', '#test'].includes(location.hash)) setMode(location.hash === '#test' ? 'test' : 'study', false); });
  window.addEventListener('wordtrail-restored', () => { quiz = null; studyKey = ''; paperKey = ''; writeStore(draftStore, {}); writeStore(paperStore, {}); refresh().catch(error => notify(error.message, true)); });
  WordtrailService.requestPersistentStorage();
  window.WordtrailIsBusy = () => busy;
  window.WordtrailReady = refresh().then(() => {
    setMode(location.hash === '#test' ? 'test' : 'study', false);
    if (['#wordbooks', '#plans'].includes(location.hash)) showDialog('#manage-dialog');
    if (location.hash === '#documents') $('#history').open = true;
  }).catch(error => {
    $('#empty-title').textContent = '暂时无法读取学习数据';
    $('#empty > p').textContent = `${error.message}。请允许浏览器保存网站数据，然后刷新。`;
    $$('[data-action]').forEach(button => { button.disabled = true; });
  });
})();
