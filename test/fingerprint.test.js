import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHROME_MAJOR,
  CHROME_FULL,
  PC_USER_AGENT,
  APP_ID,
  APP_USER_AGENT,
  APP_VERSION,
  SEC_CH_UA,
  PLATFORM,
  buildUserAgentMetadata,
  pcPageHeaders,
  pcXhrHeaders
} from '../src/core/fingerprint.js';

/**
 * 这组断言专门防「前后不对称」回归：
 * UA、客户端提示(Sec-CH-UA)、平台三者必须描述同一套身份，
 * 历史上就因为各处硬编码不同版本，出现了「UA 说 131、Sec-CH-UA 说真实版本」这种矛盾。
 */

test('UA 里的版本号与指纹常量一致', () => {
  assert.ok(PC_USER_AGENT.includes(`Chrome/${CHROME_MAJOR}.`), `UA 必须包含 Chrome/${CHROME_MAJOR}`);
  assert.ok(SEC_CH_UA.includes(`v="${CHROME_MAJOR}"`), `Sec-CH-UA 必须包含 v="${CHROME_MAJOR}"`);
  // 同一个字符串里不允许出现两个不同的 Chrome 大版本
  const majors = [...PC_USER_AGENT.matchAll(/Chrome\/(\d+)/g)].map(m => m[1]);
  assert.equal(new Set(majors).size, 1, 'UA 内不允许出现多个不同的 Chrome 版本号');
});

test('Bing App UA 与 x-rewards-appid 使用同一版本', () => {
  assert.equal(APP_ID, `SAAndroid/${APP_VERSION}`);
  assert.ok(APP_USER_AGENT.includes(`BingSapphire/${APP_VERSION}`));
});

test('UA 声明的系统与客户端提示平台一致', () => {
  assert.ok(PC_USER_AGENT.includes('Windows NT 10.0; Win64; x64'), 'UA 应声明 Windows x64');
  assert.equal(PLATFORM.clientHint, '"Windows"');
  assert.equal(PLATFORM.navigator, 'Win32');
  assert.equal(PLATFORM.userAgentData, 'Windows');
});

test('userAgentMetadata 的版本与 UA 对齐', () => {
  const meta = buildUserAgentMetadata();
  for (const b of meta.brands) {
    if (b.brand === 'Not?A_Brand') continue;
    assert.equal(b.version, CHROME_MAJOR, `brands 里 ${b.brand} 的版本必须等于 CHROME_MAJOR`);
  }
  for (const b of meta.fullVersionList) {
    if (b.brand === 'Not?A_Brand') continue;
    assert.equal(b.version, CHROME_FULL);
  }
  assert.equal(meta.platform, 'Windows');
  assert.equal(meta.mobile, false);
});

test('页面抓取头补齐了浏览器一定会带的字段', () => {
  const h = pcPageHeaders({ referer: 'https://rewards.bing.com/' });
  assert.equal(h['user-agent'], PC_USER_AGENT);
  assert.match(h['accept'], /text\/html/);
  assert.ok(h['accept-language']);
  assert.equal(h['sec-ch-ua'], SEC_CH_UA);
  assert.equal(h['sec-ch-ua-platform'], '"Windows"');
  assert.equal(h['sec-fetch-dest'], 'document');
  assert.equal(h['sec-fetch-mode'], 'navigate');
  assert.equal(h['upgrade-insecure-requests'], '1');
  // 调用方显式给的字段优先
  assert.equal(h['referer'], 'https://rewards.bing.com/');
});

test('XHR 头与页面头的区别符合浏览器行为', () => {
  const h = pcXhrHeaders({ 'x-requested-with': 'XMLHttpRequest' });
  assert.equal(h['accept'], '*/*');
  assert.equal(h['sec-fetch-dest'], 'empty');
  assert.equal(h['sec-fetch-mode'], 'cors');
  assert.equal(h['x-requested-with'], 'XMLHttpRequest');
  assert.equal(h['user-agent'], PC_USER_AGENT);
});
