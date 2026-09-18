import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createBrowserToolSession, closeBrowser } from '../packages/tagent-core/src/tools/browser.js';
import { getSharedBrowser } from '../packages/tagent-core/src/tools/browser-pool.js';

type Session = ReturnType<typeof createBrowserToolSession>;
const call = (session: Session, name: string, args: Record<string, unknown> = {}) => session.tools.find(tool => tool.definition.name === name)!.execute(args);
function reference(snapshot: string, name: string, index = 0): string {
  const lines = snapshot.split('\n').filter(line => line.includes(`: ${JSON.stringify(name)}`));
  const ref = lines[index]?.match(/\[@e\d+\]/)?.[0].slice(1, -1);
  assert.ok(ref, `Missing observed control ${name} #${index}: ${snapshot}`);
  return ref;
}

const host = 'browser-ref-acceptance.example';
const base = `http://${host}`;
let privateRequests = 0;
const privateServer = createServer((_request, response) => { privateRequests++; response.end('PRIVATE'); });
await new Promise<void>(resolve => privateServer.listen(0, '127.0.0.1', resolve));
const privateUrl = `http://127.0.0.1:${(privateServer.address() as { port: number }).port}/private`;
const nativeFetch = globalThis.fetch;
const requests: string[] = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, base, 'Unexpected external fetch in isolated browser fixture');
  requests.push(url.pathname);
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${url.pathname}</title>
    <style>body{font:16px sans-serif;margin:24px}button,input,a{display:block;margin:12px;padding:8px}button[hidden]{display:none}</style>
    <nav><a id="home" href="${url.pathname}">Home</a><button hidden>Hidden action</button></nav>
    <main><h1>Browser reference acceptance ${url.pathname}</h1>
    <button id="first" onclick="document.body.dataset.clicked='first'">Duplicate action</button>
    <button id="second" onclick="document.body.dataset.clicked='second'">Duplicate action</button>
    <label for="query">Search query</label><input id="query" name="query" placeholder="Search query">
    <input aria-label="Password field" type="password" value="fixture-password-not-for-output">
    <input aria-label="Read only" readonly value="unchanged">
    <button id="disabled" disabled>Disabled action</button>
    <button id="search" onclick="document.querySelector('#result').textContent=document.querySelector('#query').value; document.body.dataset.trusted=event.isTrusted">Search</button>
    <p id="result" role="status"></p><a id="private" href="${privateUrl}">Private address</a>
    ${url.pathname === '/long' ? Array.from({ length: 45 }, (_, index) => `<button>More item ${index}</button>`).join('') + '<button id="footer" onclick="document.body.dataset.clicked=\'footer\'">Footer action</button>' : ''}
    </main></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
};

const a = createBrowserToolSession({ allowedDomains: [host] });
const b = createBrowserToolSession({ allowedDomains: [host] });
try {
  const snapshots = await Promise.all([call(a, 'browser_navigate', { url: `${base}/alpha` }), call(b, 'browser_navigate', { url: `${base}/beta` })]);
  for (const snapshot of snapshots) {
    assert.ok(snapshot.includes('Search query') && !snapshot.includes('Hidden action'), snapshot);
    assert.equal(snapshot.split('\n').filter(line => line.includes(': "Duplicate action"')).length, 2);
    assert.ok(!snapshot.includes('fixture-password-not-for-output'));
  }
  const browser = await getSharedBrowser();
  const alpha = browser.contexts().flatMap(ctx => ctx.pages()).find(page => page.url() === `${base}/alpha`)!;
  const beta = browser.contexts().flatMap(ctx => ctx.pages()).find(page => page.url() === `${base}/beta`)!;
  assert.ok(alpha && beta && alpha.context() !== beta.context());
  const firstInputRef = reference(snapshots[0], 'Search query');
  const textA = '中文 search alpha';
  const typed = await Promise.all([
    call(a, 'browser_type', { ref: firstInputRef, text: textA }),
    call(b, 'browser_type', { ref: reference(snapshots[1], 'Search query'), text: 'beta only' }),
  ]);
  assert.ok(typed.every(output => output.startsWith('已在')), typed.join('\n'));
  assert.equal(await alpha.locator('#query').inputValue(), textA);
  assert.equal(await beta.locator('#query').inputValue(), 'beta only');
  assert.ok((await call(a, 'browser_type', { ref: firstInputRef, text: 'wrong retry' })).includes('已失效'));
  assert.equal(await alpha.locator('#query').inputValue(), textA);

  const secondRef = reference(typed[0], 'Duplicate action', 1);
  await alpha.evaluate(() => document.querySelector('#first')!.before(document.querySelector('#second')!));
  let output = await call(a, 'browser_click', { ref: secondRef });
  assert.ok(output.startsWith('已点击'), output);
  assert.equal(await alpha.locator('body').getAttribute('data-clicked'), 'second');
  assert.equal(await beta.locator('body').getAttribute('data-clicked'), null);

  const detachedRef = reference(output, 'Duplicate action', 0);
  await alpha.evaluate(() => {
    const element = document.querySelector('#second')!;
    element.replaceWith(element.cloneNode(true));
    document.body.dataset.clicked = 'not-clicked';
  });
  output = await call(a, 'browser_click', { ref: detachedRef });
  assert.ok(output.includes('元素已变化'), output);
  assert.equal(await alpha.locator('body').getAttribute('data-clicked'), 'not-clicked');

  output = await call(a, 'browser_snapshot');
  const changedRef = reference(output, 'Search');
  await alpha.locator('#search').evaluate(element => { element.textContent = 'Different action'; });
  assert.ok((await call(a, 'browser_click', { ref: changedRef })).includes('元素已变化'));
  assert.equal(await alpha.locator('body').getAttribute('data-trusted'), null);
  await alpha.locator('#search').evaluate(element => { element.textContent = 'Search'; });
  output = await call(a, 'browser_snapshot');
  assert.ok((await call(a, 'browser_type', { ref: reference(output, 'Read only'), text: 'must not write' })).includes('不是可编辑输入框'));
  assert.equal(await alpha.getByRole('textbox', { name: 'Read only' }).inputValue(), 'unchanged');
  assert.ok((await call(a, 'browser_click', { ref: reference(output, 'Disabled action') })).includes('不可用'));
  assert.ok((await call(a, 'browser_type', { ref: reference(output, 'Duplicate action'), text: 'wrong control' })).includes('不是可编辑输入框'));
  for (const ref of [null, {}, 3, '@e0', '@e2suffix']) assert.ok((await call(a, 'browser_click', { ref })).includes('无效的元素引用'));
  const searchRef = reference(output, 'Search');
  output = await call(a, 'browser_click', { ref: searchRef });
  assert.ok(output.startsWith('已点击'), output);
  assert.equal(await alpha.locator('#result').textContent(), textA);
  assert.equal(await alpha.locator('body').getAttribute('data-trusted'), 'true');

  const overlayRef = reference(output, 'Duplicate action');
  await alpha.evaluate(() => {
    const overlay = document.createElement('div'); overlay.id = 'overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:rgba(0,0,0,.05)';
    document.body.append(overlay); document.body.dataset.clicked = 'not-clicked';
  });
  output = await call(a, 'browser_click', { ref: overlayRef });
  assert.ok(output.startsWith('未能完成或确认点击'), output);
  assert.equal(await alpha.locator('body').getAttribute('data-clicked'), 'not-clicked');
  await alpha.locator('#overlay').evaluate(element => element.remove());
  output = await call(a, 'browser_snapshot');
  const delayedRef = reference(output, 'Duplicate action');
  await alpha.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:999'; document.body.append(overlay);
    setTimeout(() => { document.querySelector('#second')!.textContent = 'Changed while waiting'; overlay.remove(); }, 300);
  });
  output = await call(a, 'browser_click', { ref: delayedRef });
  assert.ok(output.includes('元素已变化'), output);
  assert.equal(await alpha.locator('body').getAttribute('data-clicked'), 'not-clicked');
  output = await call(a, 'browser_snapshot');
  const old = reference(output, 'Search query');
  await call(a, 'browser_navigate', { url: `${base}/alpha` });
  assert.ok((await call(a, 'browser_type', { ref: old, text: 'old page' })).includes('已失效'));
  assert.equal(await alpha.locator('#query').inputValue(), '');

  output = await call(a, 'browser_snapshot');
  await call(a, 'browser_click', { ref: reference(output, 'Private address') });
  assert.equal(privateRequests, 0, 'Browser reference actions must not bypass public network checks');
  output = await call(a, 'browser_navigate', { url: `${base}/long` });
  assert.ok(!output.includes(': "Footer action"'));
  output = await call(a, 'browser_scroll', { direction: 'bottom' });
  output = await call(a, 'browser_click', { ref: reference(output, 'Footer action') });
  assert.ok(output.startsWith('已点击'), output);
  assert.equal(await alpha.locator('body').getAttribute('data-clicked'), 'footer');
  await a.close();
  assert.ok(alpha.isClosed());
  assert.ok(!beta.isClosed());
  assert.ok((await call(a, 'browser_snapshot')).includes('已结束'));
  assert.ok((await call(b, 'browser_snapshot')).includes('/beta'));
  assert.equal(await beta.locator('#query').inputValue(), 'beta only');
  await b.close();
  assert.ok(beta.isClosed());
  assert.equal(browser.contexts().length, 0);
  console.log(JSON.stringify({ status: 'passed', realChromium: true, fixtureDocuments: true, modelCalls: 0,
    concurrentPages: 2, duplicateTargets: true, reorderedTarget: true, staleRefsRejected: true, trustedClicks: true,
    disabledAndOccludedBlocked: true, changedWhileWaitingBlocked: true, scrollRevealsNewControls: true,
    passwordValueOmitted: true, privateRequests, allTaskContextsClosed: true, requests: requests.length }));
} finally {
  await a.close(); await b.close(); await closeBrowser();
  globalThis.fetch = nativeFetch;
  await new Promise<void>(resolve => privateServer.close(() => resolve()));
}
