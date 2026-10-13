"""Check the PWA shell and cached dictionary with isolated storage."""
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(accept_downloads=True)
    page = context.new_page()
    page.goto('http://127.0.0.1:4176/')
    page.wait_for_load_state('networkidle')
    page.locator('[data-tool=words]').click()
    page.evaluate('navigator.serviceWorker.ready')
    page.reload()
    page.wait_for_load_state('networkidle')
    page.locator('#empty [data-action=setup]').click()
    page.locator('#import-file').set_input_files({'name':'offline.txt','mimeType':'text/plain','buffer':b'ability\nable\nabout'})
    expect(page.locator('#setup-submit')).to_be_enabled(timeout=30000)
    page.locator('#setup-target').fill('3')
    page.locator('#setup-submit').click()
    expect(page.locator('#setup-dialog')).not_to_be_visible()
    with page.expect_download(timeout=90000):
        page.locator('[data-action=study-pdf]').click()
    expect(page.locator('#history-count')).to_have_text('1 份')
    page.wait_for_load_state('networkidle')
    context.set_offline(True)
    page.reload()
    expect(page.locator('#word-count')).to_have_text('本周 3 个词')
    expect(page.locator('#history-count')).to_have_text('1 份')
    with page.expect_download(timeout=30000):
        page.locator('[data-action=study-pdf]').click()
    print('PASS offline reload retains plan, meanings, document history and cached PDF component download',flush=True)
    browser.close()
