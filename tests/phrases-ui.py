"""Isolated browser test: phrases, source ordering, independent sheets, safe book deletion."""
import base64
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from pypdf import PdfReader
import pypdfium2 as pdfium

OUT = Path(__file__).parent / 'output'
OUT.mkdir(exist_ok=True)

def check(label, value=True):
    assert value, label
    print('PASS', label, flush=True)

def post(page, path, body):
    return page.evaluate("([path,body])=>WordtrailService.request(path,{method:'POST',body:JSON.stringify(body)})", [path, body])

def state(page):
    return page.evaluate("WordtrailService.request('/api/state')")

def data(text):
    return 'data:text/plain;base64,' + base64.b64encode(text.encode()).decode()

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    ctx = browser.new_context(viewport={'width':1440, 'height':1000}, service_workers='block', accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:4174/#learn')
    page.wait_for_load_state('networkidle')
    page.wait_for_function('window.WordtrailReady')
    page.evaluate('async()=>await window.WordtrailReady')
    check('shuffle import control removed', page.locator('#setup-shuffle').count() == 0)
    source = '1. take off 起飞\n2. look   forward to [IPA] 期待\nin front of 在前面\ngive up v. 放弃\ntake care of 照顾\nbe interested in 感兴趣\nabandon n. 放弃\nability 能力\nable 能够\nabout 关于\nabove 上方\nneverlisted phrasezzzz 未收录\nTAKE OFF 重复'
    expected = ['take off','look forward to','in front of','give up','take care of','be interested in','abandon','ability','able','about','above','neverlisted phrasezzzz']
    preview = post(page, '/api/import/preview', {'filename':'phrases.txt', 'content':data(source)})
    check('TXT keeps whole phrases, trims numbering/IPA/POS/translations and deduplicates', [x['word'] for x in preview['preview']] == expected and preview['summary']['duplicate_count'] == 1)
    check('phrases use exact dictionary meanings; unknown phrase is not its head word', all(x['meaning'] for x in preview['preview'][:5]) and preview['preview'][-1]['meaning'] == '')
    cases = [
        ('phrases.json', json.dumps({'phrases':[{'phrase':'take off','meaning':'not used'},{'英文词组':'give up'}]})),
        ('map.json', json.dumps({'take off':'起飞','give up':'放弃'})),
        ('rows.json', json.dumps([['phrase','meaning'],['take off','ignored translation'],['give up','ignored translation']])),
        ('phrases.csv', '短语,中文\n"take off",起飞\n"give up",放弃'),
    ]
    for name, text in cases:
        result = post(page, '/api/import/preview', {'filename':name,'content':data(text)})
        check(name + ' keeps phrase columns and ignores translations', [x['word'] for x in result['preview']] == ['take off','give up'])
    page.add_script_tag(url='http://127.0.0.1:4174/vendor/xlsx.full.min.js')
    result = page.evaluate("""async()=>{
      const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['phrase','meaning'],['take off','old translation'],['give up','ignored']]),'Phrases');
      return WordtrailService.request('/api/import/preview',{method:'POST',body:JSON.stringify({filename:'phrases.xlsx',content:'data:application/octet-stream;base64,'+XLSX.write(wb,{type:'base64',bookType:'xlsx'})})});
    }""")
    check('Excel phrase recognition', [x['word'] for x in result['preview']] == ['take off','give up'])
    page.locator('#empty [data-action=setup]').click()
    page.locator('#import-file').set_input_files({'name':'词组练习.txt','mimeType':'text/plain','buffer':source.encode()})
    expect(page.locator('#setup-submit')).to_be_enabled(timeout=30000)
    page.locator('#setup-target').fill('12')
    page.locator('#setup-submit').click()
    expect(page.locator('#setup-dialog')).not_to_be_visible()
    initial = state(page)
    active = initial['active_plan_id']
    book_id = initial['wordbooks'][0]['id']
    check('book and weekly list retain source order', [x['word'] for x in initial['wordbooks'][0]['words']] == expected and initial['plans'][0]['week']['word_ids'] == [x['id'] for x in initial['wordbooks'][0]['words']])
    # Deterministic independent RNG streams make accidental equal permutations impossible in this test.
    page.evaluate('Math.random = () => 0')
    with page.expect_download(timeout=120000) as dl:
        page.locator('[data-action=study-pdf]').click()
    study_path = OUT/'phrases-study.pdf'
    dl.value.save_as(study_path)
    study_state = state(page)
    study_order = study_state['plans'][0]['week']['study_word_ids']
    page.evaluate('Math.random = () => 0.5')
    page.locator('#test-tab').click()
    page.locator('#paper-mode summary').click()
    with page.expect_download(timeout=120000) as dl:
        page.locator('[data-action=exam-pdf]').click()
    exam_path = OUT/'phrases-exam.pdf'
    dl.value.save_as(exam_path)
    generated = state(page)
    exam_order = [x['word']['id'] for x in generated['plans'][0]['week']['papers'][0]['items']]
    check('study and exam shuffle independently without mutating imported order', study_order != exam_order and study_order != study_state['plans'][0]['week']['word_ids'] and [x['word'] for x in generated['wordbooks'][0]['words']] == expected)
    repeated = post(page, '/api/documents/generate', {'plan_id':active,'type':'study'})
    check('repeated download preserves study order and document identity', repeated['document']['id'] == next(x['id'] for x in generated['documents'] if x['type']=='study'))
    post(page, '/api/documents/generate', {'plan_id':active,'type':'exam','exam_version':1})
    check('exam numbering remains stable', [x['word']['id'] for x in state(page)['plans'][0]['week']['papers'][0]['items']] == exam_order)
    text = ' '.join(' '.join(p.extract_text().split()) for p in PdfReader(study_path).pages)
    check('PDF contains complete English phrases and Chinese meanings', all(x in text for x in expected[:5]) and '背诵表' in text and '期望' in text)
    check('12 phrase study one page and exam one page plus separate OMR', len(PdfReader(study_path).pages)==1 and len(PdfReader(exam_path).pages)==2)
    for path in [study_path, exam_path]:
        doc=pdfium.PdfDocument(path)
        doc[0].render(scale=1.5).to_pil().save(OUT/(path.stem+'.png'))
        doc.close()
    # Historical API shuffle:true must no longer reorder either import endpoint.
    other = post(page, '/api/setup', {'filename':'other.txt','content':data('able\nabout\nabove'),'weekly_target':3,'shuffle':True})
    extra = post(page, '/api/import', {'filename':'extra.txt','content':data('above\nable\nabout'),'shuffle':True})
    current = state(page)
    check('legacy shuffle flags ignored', [x['word'] for x in next(x for x in current['wordbooks'] if x['id']==other['wordbook']['id'])['words']]==['able','about','above'] and [x['word'] for x in next(x for x in current['wordbooks'] if x['id']==extra['wordbook']['id'])['words']]==['above','able','about'])
    blocked = page.evaluate("async id=>{try{await WordtrailService.request(`/api/wordbooks/${id}/delete`,{method:'POST',body:'{}'});return false}catch(e){return e.message.includes('确认')}}",book_id)
    check('linked-plan deletion requires explicit confirmation', blocked)
    post(page, '/api/active-plan', {'plan_id':active})
    page.reload(); page.wait_for_load_state('networkidle')
    page.locator('[data-action=manage]').first.click()
    delete = page.locator(f'#manage-books [data-action=delete-book][data-id="{book_id}"]')
    page.once('dialog',lambda dialog:dialog.dismiss())
    delete.click()
    check('cancel deletion preserves book', len(state(page)['wordbooks'])==3)
    for width,height in [(375,812),(812,375),(1440,1000)]:
        page.set_viewport_size({'width':width,'height':height})
        check(f'management fits {width}px', page.evaluate('document.documentElement.scrollWidth<=innerWidth') and delete.is_visible())
        page.screenshot(path=str(OUT/f'phrases-manage-{width}.png'),full_page=True)
    confirmation=[]
    def accept(dialog):
        confirmation.append(dialog.message)
        dialog.accept()
    page.once('dialog',accept)
    delete.click()
    expect(delete).to_have_count(0)
    remaining = state(page)
    check('confirmation names linked plans and retained PDFs', '1 个学习计划' in confirmation[0] and 'PDF' in confirmation[0])
    check('deletes only chosen book and linked plan; active plan repaired', len(remaining['wordbooks'])==2 and len(remaining['plans'])==1 and remaining['active_plan_id']==other['plan']['id'])
    check('generated documents remain downloadable after book deletion', len(remaining['documents'])==2 and all(x['download_url'] for x in remaining['documents']))
    check('no uncaught browser errors',not errors)
    browser.close()
