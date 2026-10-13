(() => {
  'use strict';
  const DB = 'wrongbook-ai-v1', KEY = 'wrongbook-categories-v2', LOGS = 'wrongbook-study-logs-v1';
  let connection, drafts, queue = Promise.resolve();
  const id = () => `${Date.now()}-${crypto.randomUUID()}`;
  const today = () => new Date().toLocaleDateString('en-CA');
  function open(name = DB) {
    return new Promise((resolve,reject) => {
      const request = indexedDB.open(name,1);
      request.onupgradeneeded = () => request.result.createObjectStore(name === DB ? 'entries' : 'drafts', name === DB ? {keyPath:'id'} : undefined);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function transact(mode, action, draft = false) {
    const db = draft ? await (drafts ||= open('wrongbook-workbench-drafts-v1')) : await (connection ||= open());
    return new Promise((resolve,reject) => {
      const tx = db.transaction(draft ? 'drafts' : 'entries', mode); let result;
      try { result = action(tx.objectStore(draft ? 'drafts' : 'entries')); } catch (error) { tx.abort(); reject(error); return; }
      tx.oncomplete = () => resolve(result?.result); tx.onabort = tx.onerror = () => reject(tx.error || new Error('错题保存失败，请检查浏览器存储空间。'));
    });
  }
  function serialize(action) { const task = queue.then(action); queue = task.catch(() => {}); return task; }
  const safeImage = value => typeof value === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) && value.length < 18_000_000;
  function cleanEntry(value) {
    if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 180 || typeof value.latex !== 'string' || !value.latex.trim() || value.latex.length > 50000 || typeof value.category !== 'string') throw new Error('题目格式不正确，正文不能为空。');
    const images = value.residualImages || [];
    if (!Array.isArray(images) || images.length > 12 || images.some(src => !safeImage(src))) throw new Error('题目附图格式不正确，仅允许文件内嵌的图片。');
    const reviews = value.reviews || [];
    if (!Array.isArray(reviews) || reviews.some(review => !review || !['again','hard','good'].includes(review.result) || typeof review.date !== 'string' || typeof review.answer !== 'string')) throw new Error('复习记录格式不正确。');
    if (value.sourceImage && !safeImage(value.sourceImage)) throw new Error('题目原图格式不正确。');
    return { id:value.id, category:value.category.slice(0,80), latex:value.latex.trim(), date:typeof value.date === 'string' ? value.date.slice(0,10) : today(), residualImages:images, sourceImage:value.sourceImage || '', knowledge:String(value.knowledge || '').slice(0,100), reason:String(value.reason || '').slice(0,200), note:String(value.note || '').slice(0,5000), nextReview:typeof value.nextReview === 'string' ? value.nextReview.slice(0,10) : '', interval:Number.isFinite(value.interval) ? Math.max(0,Math.min(60,value.interval)) : 0, reviews:reviews.map(review => ({date:review.date.slice(0,10),result:review.result,answer:review.answer.slice(0,5000)})) };
  }
  function cleanCategories(values) {
    if (!Array.isArray(values) || !values.length || values.length > 30) throw new Error('请保留 1 至 30 个题类。');
    const result = values.map(value => ({id:String(value?.id || ''),title:String(value?.title || '').trim(),kind:'题目'}));
    if (result.some(value => !/^[\w-]{1,80}$/.test(value.id) || !value.title || value.title.length > 20) || new Set(result.map(value => value.id)).size !== result.length || new Set(result.map(value => value.title)).size !== result.length) throw new Error('题类名称不能为空、超过 20 字或重复。');
    return result;
  }
  async function snapshot() {
    const entries = (await transact('readonly',store => store.getAll())).sort((a,b) => a.id.localeCompare(b.id));
    let categories = [], studyLogs = [];
    try { categories = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch {}
    try { studyLogs = JSON.parse(localStorage.getItem(LOGS) || '[]'); } catch {}
    categories = categories.filter(value => value && typeof value.id === 'string' && typeof value.title === 'string').slice(0,30);
    for (const entry of entries) if (!categories.some(category => category.id === entry.category)) categories.push({id:entry.category,title:({math:'数学','math-choice':'数学填选','math-solution':'数学大题','cs-choice':'408 填选','cs-solution':'408 大题','cs-notes':'408 冷知识点'})[entry.category] || '未分类',kind:'题目'});
    if (!categories.length) categories = [{id:'general',title:'未分类',kind:'题目'}];
    return {version:2,categories,entries,studyLogs:Array.isArray(studyLogs) ? studyLogs : []};
  }
  function validateBackup(value) {
    if (!value || !Array.isArray(value.entries) || ![1,2].includes(value.version)) throw new Error('错题备份格式不正确。');
    const entries = value.entries.map(cleanEntry), categories = cleanCategories(value.categories);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length || entries.some(entry => !categories.some(category => category.id === entry.category))) throw new Error('备份包含重复题目编号或不存在的题类。');
    const studyLogs = Array.isArray(value.studyLogs) ? value.studyLogs.filter(log => typeof log?.date === 'string' && typeof log?.text === 'string').map(log => ({date:log.date.slice(0,10),text:log.text.slice(0,5000)})) : [];
    return {version:2,categories,entries,studyLogs};
  }
  const restore = value => serialize(async () => {
    const data = validateBackup(value), priorCategories = localStorage.getItem(KEY), priorLogs = localStorage.getItem(LOGS);
    try {
      localStorage.setItem(KEY,JSON.stringify(data.categories)); localStorage.setItem(LOGS,JSON.stringify(data.studyLogs));
      await transact('readwrite',store => { store.clear(); for (const entry of data.entries) store.put(entry); });
      await transact('readwrite',store => store.clear(),true);
    } catch (error) {
      if (priorCategories === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY,priorCategories);
      if (priorLogs === null) localStorage.removeItem(LOGS); else localStorage.setItem(LOGS,priorLogs);
      throw error;
    }
  });
  async function saveMany(values) {
    const data = values.map(cleanEntry), {categories} = await snapshot();
    if (data.some(entry => !categories.some(category => category.id === entry.category))) throw new Error('题类已改变，请重新选择。');
    return transact('readwrite',store => { data.forEach(entry => store.put(entry)); });
  }
  async function saveCategories(values) {
    const categories = cleanCategories(values), {entries} = await snapshot();
    if (entries.some(entry => !categories.some(category => category.id === entry.category))) throw new Error('有题目的题类不能删除，请先移动题目。');
    localStorage.setItem(KEY,JSON.stringify(categories));
  }
  function review(entry,result,answer) {
    if (!['again','hard','good'].includes(result)) throw new Error('请选择复习结果。');
    const interval = result === 'again' ? 1 : result === 'hard' ? 2 : Math.min(60,Math.max(3,(entry.interval || 1)*2));
    const due = new Date(); due.setDate(due.getDate()+interval);
    return {...entry,interval,nextReview:due.toLocaleDateString('en-CA'),reviews:[...(entry.reviews || []),{date:today(),result,answer:String(answer || '').slice(0,5000)}]};
  }
  window.WrongbookStore = {snapshot,validateBackup,exportBackup:snapshot,restore,review,id,today,safeImage,saveMany:values => serialize(() => saveMany(values)),saveCategories:values => serialize(() => saveCategories(values)),remove:entryId => serialize(() => transact('readwrite',store => store.delete(entryId))),draft:() => transact('readonly',store => store.get('current'),true),saveDraft:value => serialize(() => transact('readwrite',store => value ? store.put(value,'current') : store.delete('current'),true))};
})();
