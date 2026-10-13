(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const scripts = new Map();
  let routeToken = 0, active = '', dataBusy = false, toastTimer;
  function notify(message, error = false) {
    $('#toast').textContent = message; $('#toast').classList.toggle('error', error); $('#toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 4000);
  }
  function script(path) {
    if (!scripts.has(path)) scripts.set(path, new Promise((resolve, reject) => {
      const element = document.createElement('script'); element.src = path;
      element.onload = resolve;
      element.onerror = () => { scripts.delete(path); element.remove(); reject(new Error('组件加载失败，请联网后重试。')); };
      document.head.append(element);
    }));
    return scripts.get(path);
  }
  function style(path) {
    if (document.querySelector(`link[href="${path}"]`)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const element = document.createElement('link'); element.rel = 'stylesheet'; element.href = path;
      element.onload = resolve; element.onerror = () => { element.remove(); reject(new Error('公式样式加载失败，请重试。')); };
      document.head.append(element);
    });
  }
  async function words() { await script('static-service.js'); await script('app.js'); await window.WordtrailReady; }
  async function wrongbook() { await script('wrongbook-store.js'); await script('wrongbook.js'); await window.WrongbookReady; }
  async function route() {
    const token = ++routeToken, hash = location.hash;
    const next = hash.startsWith('#wrongbook') ? 'wrongbook' : ['#learn','#test','#words','#wordbooks','#plans','#documents','#dashboard'].includes(hash) ? 'words' : '';
    $('#wordtrail-tool').hidden = next !== 'words'; $('#wrongbook-tool').hidden = next !== 'wrongbook';
    document.querySelectorAll('[data-tool]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tool === next)));
    $('#desk-loading').hidden = !next; $('#desk-loading').textContent = next ? '正在打开…' : '';
    try {
      if (next === 'words') await words();
      if (next === 'wrongbook') await wrongbook();
      if (token !== routeToken) return;
      if (active !== next) { window.scrollTo(0,0); active = next; }
    } catch (error) { if (token === routeToken) notify(error.message, true); }
    finally { if (token === routeToken) $('#desk-loading').hidden = true; }
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function services() { await Promise.all([script('static-service.js'), script('wrongbook-store.js')]); }
  function validateWordBackup(value) {
    if (value?.format !== 'wordtrail-backup' || value.version !== 1 || !value.state || !['wordbooks','plans','documents'].every(key => Array.isArray(value.state[key])) || !Array.isArray(value.documents)) throw new Error('单词备份格式不正确。');
    for (const doc of value.documents) if (typeof doc.id !== 'string' || typeof doc.data !== 'string' || !/^[A-Za-z0-9+/=]*$/.test(doc.data)) throw new Error('备份中的 PDF 数据无效。');
  }
  async function backup(button) {
    if (dataBusy) return; dataBusy = true; button.disabled = true;
    try {
      await services();
      const result = { format: 'study-workbench-backup', version: 1, exportedAt: new Date().toISOString(), wordtrail: JSON.parse(await (await WordtrailService.exportBackup()).text()), wrongbook: await WrongbookStore.exportBackup() };
      download(new Blob([JSON.stringify(result)], {type:'application/json'}), `学习工作台备份_${new Date().toLocaleDateString('en-CA')}.json`);
      notify('备份已下载，包含词表、错题、复习记录和单词 PDF，不含 AI 凭据。');
    } catch (error) { notify(error.message, true); }
    finally { dataBusy = false; button.disabled = false; $('.data-menu').open = false; }
  }
  async function restore(file) {
    if (!file || dataBusy) return;
    if (window.WordtrailIsBusy?.() || window.WrongbookIsBusy?.()) { notify('请等待当前保存、识别或导出完成后再导入备份。',true); $('#desk-restore-file').value=''; return; }
    dataBusy = true; let beforeWords, beforeWrong, wrote = false;
    try {
      const data = JSON.parse(await file.text()); await services();
      let wordData, wrongData;
      if (data.format === 'study-workbench-backup' && data.version === 1) { wordData = data.wordtrail; wrongData = data.wrongbook; }
      else if (data.format === 'wordtrail-backup') wordData = data;
      else if (Array.isArray(data.entries)) wrongData = data;
      else throw new Error('请选择工作台、词轨或原错题本导出的 JSON 备份。');
      if (wordData) validateWordBackup(wordData);
      if (wrongData) wrongData = WrongbookStore.validateBackup(wrongData);
      if (!confirm(`将替换当前浏览器中的${wordData && wrongData ? '单词与错题' : wordData ? '单词' : '错题'}数据。其他工具的数据不受影响。确定导入？`)) return;
      beforeWords = wordData ? await WordtrailService.exportBackup() : null;
      beforeWrong = wrongData ? await WrongbookStore.exportBackup() : null;
      wrote = true;
      if (wordData) await WordtrailService.importBackup(new Blob([JSON.stringify(wordData)], {type:'application/json'}));
      if (wrongData) await WrongbookStore.restore(wrongData);
      if (wordData) window.dispatchEvent(new Event('wordtrail-restored'));
      if (wrongData) window.dispatchEvent(new Event('wrongbook-restored'));
      notify('备份已导入。');
    } catch (error) {
      if (wrote) {
        try { if (beforeWords) await WordtrailService.importBackup(beforeWords); if (beforeWrong) await WrongbookStore.restore(beforeWrong); }
        catch { notify('导入与回滚未完成。请保留刚才使用的备份文件并重试。', true); return; }
      }
      notify(`未完成导入：${error.message}`, true);
    } finally { dataBusy = false; $('#desk-restore-file').value = ''; $('.data-menu').open = false; }
  }
  document.addEventListener('click', event => {
    const tool = event.target.closest('[data-tool]'); if (tool) location.hash = tool.dataset.tool === 'words' ? 'learn' : 'wrongbook';
    const button = event.target.closest('[data-desk]');
    if (button?.dataset.desk === 'backup') backup(button);
    if (button?.dataset.desk === 'restore') $('#desk-restore-file').click();
    if (!event.target.closest('.data-menu')) $('.data-menu').open = false;
  });
  $('#desk-restore-file').addEventListener('change', event => restore(event.target.files[0]));
  window.addEventListener('hashchange', route);
  if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  window.Workbench = { script, style, notify, download, get dataBusy() { return dataBusy; } };
  route();
})();
