import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msr-v11021-'));
process.env.MSR_DATA_DIR = testTmpDir;

const { selectQuestSubtaskDepth } = await import('../src/core/questStatus.js');
const { browserManager } = await import('../src/core/browser.js');

// ---- 极简 DOM stub（项目没有 jsdom，scanQuestSubtasks 只需要少数几个 API） ----
class FakeElement {
  constructor(tag, text) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attrs = new Map();
    this.text = text || '';
  }

  get innerText() {
    if (this.children.length === 0) return this.text;
    return this.children.map(c => c.innerText).join('\n');
  }

  get textContent() {
    return this.innerText;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  closest(tag) {
    const want = String(tag).toUpperCase();
    let node = this;
    while (node) {
      if (node.tagName === want) return node;
      node = node.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    return queryAll(this, selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function collectAll(root, out) {
  for (const child of root.children) {
    out.push(child);
    collectAll(child, out);
  }
  return out;
}

// 只认识 scanQuestSubtasks 真正用到的几种选择器；状态图标类选择器一律不命中。
function matchPart(el, part) {
  if (part === 'h3') return el.tagName === 'H3';
  if (part === 'a[href]') return el.tagName === 'A' && el.getAttribute('href') !== null;
  if (part === 'button') return el.tagName === 'BUTTON';
  if (part === '[data-msr-subtask]') return el.getAttribute('data-msr-subtask') !== null;
  return false;
}

function queryAll(root, selector) {
  const parts = String(selector).split(',').map(s => s.trim()).filter(Boolean);
  const all = collectAll(root, []);
  return all.filter(el => parts.some(part => matchPart(el, part)));
}

function makeDocument(body) {
  return {
    body,
    querySelectorAll(selector) { return queryAll(body, selector); },
    querySelector(selector) { return queryAll(body, selector)[0] || null; }
  };
}

function buildPage() {
  const root = new FakeElement('#document');
  const body = root.append(new FakeElement('body'));
  return { root, body, documentStub: makeDocument(body) };
}

function makeCard(parent, title, href, actionText) {
  const card = parent.append(new FakeElement('div'));
  card.append(new FakeElement('h3', title));
  const link = card.append(new FakeElement('a', actionText));
  if (href) link.setAttribute('href', href);
  return { card, link };
}

const fakePage = { evaluate: async (fn, arg) => fn(arg) };

async function scan(documentStub) {
  globalThis.document = documentStub;
  try {
    return await browserManager.scanQuestSubtasks(fakePage);
  } finally {
    delete globalThis.document;
  }
}

// ---- selectQuestSubtaskDepth ----
test('selectQuestSubtaskDepth 在卡片边界停下，不越过共享外层', () => {
  const frames = [
    { h3Count: 0, linkCount: 0 },
    { h3Count: 1, linkCount: 1 },
    { h3Count: 5, linkCount: 1 }
  ];
  assert.equal(selectQuestSubtaskDepth(frames), 1);
});

test('selectQuestSubtaskDepth 拒绝 document.body 作为容器', () => {
  const frames = [
    { h3Count: 0, linkCount: 0 },
    { h3Count: 1, linkCount: 0 },
    { h3Count: 5, linkCount: 40, isBody: true }
  ];
  assert.equal(selectQuestSubtaskDepth(frames), 1);
});

test('selectQuestSubtaskDepth 遵守 depthLimit 与空输入', () => {
  const frames = [
    { h3Count: 0, linkCount: 0 },
    { h3Count: 1, linkCount: 0 },
    { h3Count: 9, linkCount: 9 }
  ];
  assert.equal(selectQuestSubtaskDepth(frames, { depthLimit: 2 }), 1);
  assert.equal(selectQuestSubtaskDepth([], {}), -1);
  assert.equal(selectQuestSubtaskDepth(null), -1);
  assert.equal(selectQuestSubtaskDepth([{ h3Count: 2, linkCount: 1 }]), -1);
});

// ---- scanQuestSubtasks ----
test('每张卡片各有 CTA 时编号连续且每个编号唯一命中', async () => {
  const { body, documentStub } = buildPage();
  const list = body.append(new FakeElement('div'));
  const cards = [];
  for (let i = 1; i <= 5; i++) {
    cards.push(makeCard(list, '卡片' + i, 'https://www.bing.com/search?q=card' + i, '去搜索' + i));
  }

  const items = await scan(documentStub);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map(item => item.index), [1, 2, 3, 4, 5]);

  const marked = queryAll(body, '[data-msr-subtask]');
  assert.equal(marked.length, 5);
  for (let i = 0; i < 5; i++) {
    assert.equal(marked[i], cards[i].link);
    assert.equal(cards[i].link.getAttribute('data-msr-subtask'), String(i + 1));
  }
});

test('只有共享外层一个 CTA 时不会把整块塌缩成一条', async () => {
  const { body, documentStub } = buildPage();
  const shared = body.append(new FakeElement('div'));
  const cards = [];
  for (let i = 1; i <= 5; i++) {
    const hasCta = i === 3;
    cards.push(makeCard(shared, '卡片' + i, hasCta ? 'https://www.bing.com/search?q=only3' : '', '去搜索' + i));
  }
  const globalCta = shared.append(new FakeElement('a', '查看全部'));
  globalCta.setAttribute('href', 'https://www.bing.com/earn');

  const items = await scan(documentStub);
  assert.equal(items.length, 1);
  assert.equal(items[0].index, 1);
  assert.equal(items[0].title, '卡片3');
  assert.equal(items[0].href, 'https://www.bing.com/search?q=only3');
  assert.equal(cards[2].link.getAttribute('data-msr-subtask'), '1');
  assert.equal(globalCta.getAttribute('data-msr-subtask'), null);
});

test('导航类链接不会被当作子任务 CTA', async () => {
  const { body, documentStub } = buildPage();
  const nav = body.append(new FakeElement('footer'));
  const navLink = nav.append(new FakeElement('a', '关于'));
  navLink.setAttribute('href', '/rewards/about');

  const list = body.append(new FakeElement('div'));
  makeCard(list, '卡片1', 'https://www.bing.com/search?q=card1', '去搜索1');

  const items = await scan(documentStub);
  assert.equal(items.length, 1);
  assert.equal(items[0].href, 'https://www.bing.com/search?q=card1');
  assert.equal(navLink.getAttribute('data-msr-subtask'), null);
});

test('重复扫描会先清掉上一轮遗留的编号', async () => {
  const { body, documentStub } = buildPage();
  const list = body.append(new FakeElement('div'));
  makeCard(list, '卡片1', 'https://www.bing.com/search?q=card1', '去搜索1');

  const first = await scan(documentStub);
  assert.equal(first.length, 1);

  const stray = body.append(new FakeElement('a', '游离'));
  stray.setAttribute('href', 'https://example.com/x');
  stray.setAttribute('data-msr-subtask', '9');

  const second = await scan(documentStub);
  assert.equal(second.length, 1);
  assert.equal(stray.getAttribute('data-msr-subtask'), null);
  const marked = queryAll(body, '[data-msr-subtask]');
  assert.equal(marked.length, 1);
  assert.equal(marked[0].getAttribute('data-msr-subtask'), '1');
});

// ---- 源码守卫 ----
test('scanQuestSubtasks 不再用标题下标给 CTA 编号', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/core/browser.js'), 'utf-8');
  const start = source.indexOf('async scanQuestSubtasks(page)');
  assert.ok(start > 0, 'scanQuestSubtasks 应存在于 src/core/browser.js');
  const end = source.indexOf('async readQuestPageProgress', start);
  const bodySource = source.slice(start, end);
  assert.ok(!bodySource.includes('String(i + 1)'), '不得再用标题下标编号');
  assert.ok(!bodySource.includes('index: i + 1'), '不得再用标题下标作 index');
  assert.ok(bodySource.includes('selectQuestSubtaskDepth'), '应调用 selectQuestSubtaskDepth 决定容器边界');
  assert.ok(bodySource.includes("removeAttribute('data-msr-subtask')"), '扫描前应清理旧编号');
});
