/**
 * 浏览器指纹唯一来源 (single source of truth)
 *
 * 背景：项目以前在 browser.js / api.js / auth.js / epic.js 里各自硬编码了 UA 字符串，
 * 结果出现了「前后不对称」——UA 说 Windows + Edge 131，但同一请求里的
 * Sec-CH-UA（客户端提示）说的是真实版本，navigator.platform 说的是真实系统，
 * 三处互相矛盾。这种矛盾是反爬最廉价的一致性校验之一。
 *
 * 这里把身份收敛到一处，并且：
 *   - 版本号只在这里维护，升级镜像里的 Chromium 时同步改 CHROME_MAJOR；
 *   - Playwright 路径用 CDP 把 UA / Sec-CH-UA / navigator.platform 一次性对齐；
 *   - 纯 HTTP 路径补齐真实浏览器一定会带的请求头，不再只发一个孤零零的 UA。
 *
 * 注意：这里刻意不声称 Microsoft Edge。镜像里跑的是 Chromium，
 * 而 Edge 与 Chromium 的版本号并不同步（Debian chromium 150 时 Edge Linux 才 143），
 * 声称 Edge 会引入「不存在的 Edge 版本」这种新矛盾。Chrome 与 Chromium 同引擎同版本号，
 * 是代价最小的自洽选择。
 */

// 与镜像内 chromium 的主版本保持一致（当前镜像为 156）。
// 升级基础镜像后如果这里落后了，启动时会打印提醒，不会静默产生版本矛盾。
export const CHROME_MAJOR = '156';
export const CHROME_FULL = `${CHROME_MAJOR}.0.0.0`;

export const PLATFORM = {
  // navigator.platform 的取值
  navigator: 'Win32',
  // Sec-CH-UA-Platform 的取值（带引号）
  clientHint: '"Windows"',
  // userAgentData.platform
  userAgentData: 'Windows',
  platformVersion: '10.0.0',
  architecture: 'x86',
  bitness: '64'
};

/** PC 端浏览器 UA */
export const PC_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL} Safari/537.36`;

/** 移动端 / App 端 UA（保持不变，那是另一条真实存在的通道） */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 EdgA/131.0.0.0';

export const APP_VERSION = '34.5.450113001';
export const APP_ID = `SAAndroid/${APP_VERSION}`;

export const APP_USER_AGENT =
  `Mozilla/5.0 (Linux; Android 16; Redmi K20 Pro Build/BP4A.251205.006; ) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Mobile Safari/537.36 BingSapphire/${APP_VERSION}`;

/** 桌面奖励客户端 UA */
export const DESKTOP_APP_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) MSRewards/Desktop/1.4.56';

/** Sec-CH-UA 请求头，与上面的 UA 版本严格对应 */
export const SEC_CH_UA =
  `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not?A_Brand";v="24"`;

/** 供 CDP Emulation.setUserAgentOverride 使用的元数据（决定 Sec-CH-UA* 与 userAgentData） */
export function buildUserAgentMetadata() {
  return {
    brands: [
      { brand: 'Google Chrome', version: CHROME_MAJOR },
      { brand: 'Chromium', version: CHROME_MAJOR },
      { brand: 'Not?A_Brand', version: '24' }
    ],
    fullVersionList: [
      { brand: 'Google Chrome', version: CHROME_FULL },
      { brand: 'Chromium', version: CHROME_FULL },
      { brand: 'Not?A_Brand', version: '24.0.0.0' }
    ],
    fullVersion: CHROME_FULL,
    platform: PLATFORM.userAgentData,
    platformVersion: PLATFORM.platformVersion,
    architecture: PLATFORM.architecture,
    model: '',
    mobile: false,
    bitness: PLATFORM.bitness
  };
}

/**
 * 以浏览器身份抓取 HTML 页面时要带的请求头。
 * 真实 Chrome 访问页面时这些头一定会有；只发 UA 不发这些，等于自报「不是浏览器」。
 * extra 里显式给出的字段优先（例如 referer / cookie）。
 */
export function pcPageHeaders(extra = {}) {
  return {
    'user-agent': PC_USER_AGENT,
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': PLATFORM.clientHint,
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    'priority': 'u=0, i',
    ...extra
  };
}

/**
 * 以浏览器身份发起 XHR / fetch（JSON、上报类接口）时要带的请求头。
 * 与 pcPageHeaders 的区别：accept 不是 HTML、Sec-Fetch-Dest 为 empty、Mode 为 cors。
 */
export function pcXhrHeaders(extra = {}) {
  return {
    'user-agent': PC_USER_AGENT,
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': PLATFORM.clientHint,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    ...extra
  };
}

/**
 * 为无头浏览器 Context 注入 WebGL 常见核显指纹，消除 SwiftShader 软件渲染特征。
 */
export async function applyWebGLFingerprint(context) {
  if (!context?.addInitScript) return;
  await context.addInitScript(() => {
    const VENDOR = 'Google Inc. (Intel)';
    const RENDERER = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const patch = (proto) => {
      if (!proto || !proto.getParameter) return;
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 37445) return VENDOR;
        if (p === 37446) return RENDERER;
        return orig.call(this, p);
      };
      proto.getParameter.toString = () => orig.toString();
    };
    try {
      patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
      patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    } catch {}
  });
}

/**
 * 创建新页面并使用 CDP Emulation.setUserAgentOverride 一次性对齐指纹
 */
export async function createAlignedPage(context) {
  const page = await context.newPage();
  await alignPageFingerprint(context, page);
  return page;
}

/**
 * 对齐一个已经存在的页面。VNC 登录窗口使用持久化上下文时，
 * 初始页面不是由 createAlignedPage 创建的，需要单独对齐。
 */
export async function alignPageFingerprint(context, page) {
  if (!context || !page) return page;
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: PC_USER_AGENT,
      acceptLanguage: 'zh-CN,zh',
      platform: PLATFORM.navigator,
      userAgentMetadata: buildUserAgentMetadata()
    });
  } catch {}
  return page;
}
