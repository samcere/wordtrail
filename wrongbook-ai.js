(() => {
  'use strict';
  let key = '', provider = 'manual', model = '';
  function configure(values) { if (!['manual','openai','deepseek'].includes(values.provider)) throw new Error('请选择识别方式。'); provider = values.provider; model = values.model.trim(); key = values.key.trim(); }
  function outputText(body) { return typeof body.output_text === 'string' ? body.output_text : (body.output || []).flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text || '').join('\n'); }
  async function ask(instructions,text,images = []) {
    if (provider === 'manual') throw new Error('当前使用粘贴识别结果方式。若需网页自动识别，请在可选设置中填写自己的 API 信息。');
    if (!model) throw new Error('请在 AI 设置中填写模型名称。');
    const content = [{type:'input_text',text},...images.map(image => ({type:'input_image',image_url:image,detail:'high'}))];
    if (!key) throw new Error('请在 AI 设置中填写自己的 API 密钥。');
    const openai = provider === 'openai';
    const endpoint = openai ? 'https://api.openai.com/v1/responses' : 'https://api.deepseek.com/chat/completions';
    const payload = openai ? {model,store:false,instructions,input:[{role:'user',content}],max_output_tokens:12000} : {model,max_tokens:12000,messages:[{role:'system',content:instructions},{role:'user',content:[{type:'text',text},...images.map(image => ({type:'image_url',image_url:{url:image}}))]}]};
    let response;
    try { response = await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(240000)}); }
    catch { throw new Error('无法连接模型服务，可能是网络或浏览器跨域限制。可以粘贴外部识别结果，或直接整理原图。'); }
    const result = await response.json();
    if (!response.ok) throw new Error(String(result.error?.message || `模型服务返回 ${response.status}`).slice(0,300));
    const output = openai ? outputText(result) : result.choices?.[0]?.message?.content;
    if (typeof output !== 'string' || !output.trim()) throw new Error('模型未返回文本。请确认所选模型支持当前输入。');
    return output;
  }
  function parse(raw,categories) {
    const stripped = raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    let data; try { data = JSON.parse(stripped); } catch { const start = stripped.indexOf('{'),end = stripped.lastIndexOf('}'); if (start < 0 || end <= start) throw new Error('识别结果不是有效 JSON。'); try { data = JSON.parse(stripped.slice(start,end+1)); } catch { throw new Error('识别结果不是有效 JSON。'); } }
    const questions = Array.isArray(data.questions) ? data.questions : typeof data.latex === 'string' ? [data] : [];
    if (!questions.length || questions.length > 30) throw new Error('每次识别应返回 1 至 30 道题目。');
    return questions.map(question => {
      if (typeof question?.latex !== 'string' || !question.latex.trim()) throw new Error('识别结果有空题目，请重新识别或手动整理。');
      const latex = question.latex.trim().replace(/^```(?:latex|tex|text)?\s*/i,'').replace(/\s*```$/,'');
      if (latex.length > 50000 || /\\(?:documentclass|usepackage|begin|end|includegraphics|chapter|section)\b/i.test(latex)) throw new Error('正文必须是题目片段，不能包含完整文档或排版指令。');
      if ((latex.match(/(?<!\\)\$/g) || []).length % 2) throw new Error('识别结果中的公式没有闭合，请校对后重新导入。');
      const regions = (Array.isArray(question.residual_regions) ? question.residual_regions : []).slice(0,8).map(region => {
        const x = Math.max(0,Math.min(1,Number(region?.x)||0)), y = Math.max(0,Math.min(1,Number(region?.y)||0));
        return {x,y,width:Math.max(0,Math.min(1-x,Number(region?.width)||0)),height:Math.max(0,Math.min(1-y,Number(region?.height)||0)),reason:String(region?.reason || '题目附图').slice(0,60)};
      }).filter(region => region.width > .015 && region.height > .015);
      return {latex,category:categories.some(category => category.id === question.category_suggestion) ? question.category_suggestion : categories[0].id,regions};
    });
  }
  window.WrongbookAI = {configure,ask,parse,get provider(){return provider;},get model(){return model;}};
})();
