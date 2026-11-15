# 下一版本待办

## 已完成于 v1.10.20

- [x] 打孔卡子任务改为按 href 判定动作：卡片指向 `bing.com/search?q=...` 时一律按搜索执行，不再因按钮文案写着“查看热门优惠”被判成浏览，修复月度打孔卡长期卡在 1/5、2/5。
- [x] 拟人鼠标点击被子任务卡片遮罩吃掉时，降级为页面内原生 DOM 点击，不再另开空白页裸跳，避免丢掉 Referer 让官网不认这次推广访问。
- [x] 直接打开官网搜索链接时显式带上 Referer，让微软服务端识别为 Rewards 推广触发的搜索。
- [x] 两个打孔卡搜索分支都校验必应登录态，游客态落地页直接中止，不再把游客态搜索当成成功空跑。
- [x] 回归测试 321 项：318 项通过，3 项失败均为 Linux 容器环境专用用例（/dev/dri 检测、会话文件权限 0600、Chromium 回退），与本次改动无关。

## 已完成于 v1.8.0

- [x] Epic 领取结果为 `claimed` 或 `owned` 时自动关闭 VNC 小窗。
- [x] 新增“恭喜白嫖成功”网页弹窗，展示账号、游戏与入库状态。
- [x] 使用本地 Canvas 礼花庆祝，不依赖外部 CDN，并支持减少动态效果。
- [x] 桌面与手机视口视觉检查通过，无横向溢出。
- [x] 回归测试 138 项全部通过。

## 已完成于 v1.7.20

- [x] 结账按钮跨主页面与 iframe 查找，修复 VNC 中可见但脚本找不到“添加到库”的问题。
- [x] 活跃人机验证遮罩优先于结账按钮，避免越过遮罩点击或等到浏览器关闭。
- [x] 结账按钮普通点击失败后优先降级为 DOM 点击，避免强制点击落到遮罩上假成功，并支持切换到新标签页。
- [x] 成功提示只认可见的入库文案，收紧宽泛“感谢”导致的误判。
- [x] 回归测试 135 项全部通过。

## 已完成于 v1.7.19

- [x] 修复 Patchright 下 `addInitScript` 不生效的问题，页面加载后主动注入 WebGL 伪装。
- [x] 每次 Epic 页面导航后重新应用 WebGL 伪装。
- [x] 指纹自检确认 SwiftShader 标识被替换为常见 Intel 核显。
- [x] 回归测试 130 项全部通过。

## 已完成于 v1.7.18

- [x] Chromium 在 Xvfb 中启用 SwiftShader WebGL，并将软件渲染标识伪装为常见核显。
- [x] 结账按钮出现时实时切换为 `checkout`，避免验证等待后误关闭结账窗口。
- [x] 指纹自检统一返回 Chromium 版本。
- [x] 回归测试 130 项全部通过。

## 已完成于 v1.7.17

- [x] 结账按钮存在时优先返回 `checkout` 状态，不再被残留 `TRY AGAIN` 误导。
- [x] 验证等待过程中实时检测结账弹窗，避免 `Escape` 关闭已经出现的结账窗口。
- [x] 删除 Playwright Firefox 依赖、浏览器安装、专用源码与测试。
- [x] 镜像只保留 Chromium，预计减少约 294MB 浏览器层。
- [x] 回归测试 129 项全部通过。

## 已完成于 v1.7.16

- [x] 验证码消失后，可见的“添加到库”按钮优先于残留 `TRY AGAIN` 文案。
- [x] 校验按钮遍历当前免费游戏并同步“已在库 / 可领取 / 未确认”状态。
- [x] 校验弹窗展示每个游戏的入库明细。
- [x] 新增结账按钮优先级与入库同步回归测试，测试总数 137。

## 已完成于 v1.7.15

- [x] Epic 检测到人机验证时自动打开 VNC 小窗。
- [x] 人工验证后重新检查“领取成功 / 已在库中”，避免继续重试。
- [x] 确认订单后轮询成功状态最多 25 秒，适配慢回调。
- [x] 停止接口立即返回，`claimOne` 将 `retrying` 正确收尾为 `idle`。
- [x] 新增 v1.7.15 回归测试，测试总数 135。

## 已完成于 v1.7.14

- [x] Epic 人机验证时尝试关闭覆盖层与点击 `TRY AGAIN`。
- [x] 验证层出现后默认等待 90 秒，允许在 WebUI 可见浏览器中人工完成。
- [x] 支持 `EPIC_CHALLENGE_WAIT_SEC` 配置人工验证等待时间。
- [x] 商品页 `获取`按钮出现后等待水合并复核账号接口，减少过早点击。

## 已完成于 v1.7.13

- [x] Epic 登录、账号体检与免费游戏领取统一使用 Chromium + Patchright。
- [x] 领取使用独立 Chromium profile，避免复用 Firefox 领取 profile。
- [x] 删除 Epic 账号时同步清理 Chromium 领取 profile。
- [x] 保留领取前的 Epic 账号 JSON 接口预检。
- [x] 新增 v1.7.13 回归测试，测试总数 133。

## 已完成于 v1.7.12

- [x] Epic 登录态改用 `/id/api/account` JSON 接口确认，不依赖慢页面的 `isloggedin`。
- [x] 保存登录凭据前用隔离浏览器上下文复验 storageState。
- [x] 领取前先校验账号接口，修复商品页早期登录链接导致的 `auth_expired` 误判。
- [x] 商品页登录链接出现时继续等待“获取”按钮，不再立即判定掉登录。
- [x] Chromium 登录窗口关闭 QUIC，减少受限网络中的连接等待。
- [x] 新增 v1.7.12 回归测试，测试总数 132。

## 已完成于 v1.7.11

- [x] Epic 人工登录窗口从 Firefox 切换到 Chromium + Patchright，规避 `captcha_invalid`。
- [x] 登录使用独立 Chromium profile，不再继承 Firefox 领取 profile 或旧会话。
- [x] Chromium 可执行文件探测覆盖 Docker、macOS 与 Windows，并复用微软任务的浏览器路径逻辑。
- [x] 删除 Epic 账号时同步清理 Chromium 登录 profile。
- [x] 新增 v1.7.11 回归测试，测试总数 128。

## 已完成于 v1.7.10

- [x] Bing 登录态检测：优先读取 `#id_n` / `#id_a` 的真实用户名，避免空 `.id_name` 导致 PC 搜索误报“游客态”。
- [x] Super Duolingo 打孔卡：改为按任务卡 `href` 精确关联标题和进度，避免 `FY27` 宽泛匹配到已完成的月度卡后被跳过。
- [x] Epic 登录：允许 hCaptcha/Talon 所需的跨站 Cookie，关闭 HTTP/3 与 IPv6 尝试，修复验证码后直接报“服务暂时不可用”。
- [x] Epic 登录窗口关闭后同步清理残留状态。
- [x] 新增 v1.7.10 回归测试，测试总数 126。

## 已完成于 v1.7.9

- [x] 搜索进度只认官网，删除本地 `+3` 与 `max(本地, 官网)` 假进度。
- [x] 连续 5 次搜索官网无增长停止当日搜索，并区分“搜索已提交”和“官网已计分”。
- [x] 打孔卡子任务按稳定键持久化冷却，支持激活后继续搜索、外部浏览和多日 `1/5` 任务。
- [x] 只有官网确认的步骤才写入 `progress/stepLogs`，清理重复步骤。
- [x] 暂停账号完全冻结自动任务与自动 Token 刷新，保留数据；手动体检和手动刷新进度仍可用。
- [x] 账号状态统一为 🔵 运行中、🟡 已暂停、🔴 凭据失效、🟢 正常、⚪ 未检测。
- [x] 浏览器会话指纹改用 `_U`/`MUID`/`WLS`，Token 轮换不再误删会话。
- [x] 新增 v1.7.9 回归测试，测试总数 122。

## 已完成于 v1.7.5

- [x] 合并 Halloween 中英文重复打孔卡，取真实较高进度，修复面板 `0/6` 覆盖官网 `5/6`。
- [x] 子任务完成判断改用页面成功图标/空圆圈，不再误把描述里的 `(1/5 天已完成)` 当成任务完成。
- [x] 动态打孔卡按任务名精确匹配，月度第 3 项点击后已实测推进 `2/5 -> 3/5`。
- [x] Token/Cookie 异常账号跳过定时任务；手动运行、卡片操作与单次测搜统一拒绝并显示原因。
- [x] 修复新建 Epic 账号时“打开可见浏览器登录”按钮无响应，改为自动保存账号后打开登录窗口。
- [x] 新增 v1.7.5 回归测试，覆盖重复任务合并、子任务误判和异常账号拦截。

## v1.7.4 根因记录（已完成修复）

> 以下根因分析已在 v1.7.4 修复并加入回归测试，保留作为问题定位与后续维护说明。

- [x] Epic 登录窗口/活动浏览器 `close()` 卡死不再泄漏 Firefox 资源锁；删除账号会先关闭登录窗口并清理普通/登录 profile。
- [x] Daily Set 卡片动作只执行 `dailyset` 卡片，不再误跑打孔卡；活动卡片与动态打孔卡按正确目标执行。
- [x] 移动端 Token 归属校验：网页端余额与 DAPI 余额明显不一致时拒绝 App 签到/阅读，并在账号体检中标为异常。
- [x] `getBalance()` 改为网页 Cookie 余额优先，避免错误 Token 覆盖当前账号余额。
- [x] `getAppCheckInStatus()` 改为 `/dashboard` 权威状态优先，消除 `/earn` 旧数据误报。
- [x] 配置向导换取 Token 改为草稿模式；清空移动端凭据会同时清空 Refresh/Access Token。
- [x] Epic 周期预设只更新检测间隔，不再重置自动领取时间、重试次数等其他设置。
- [x] noVNC 兼容 `/novnc/websockify`，并从 compose 移除可绕过 WebUI 鉴权的宿主机 `6080` 直连端口。
- [x] 新增 `test/fixes174.test.js`，覆盖上述关键回归；当前测试总数 94。

### P0 — Epic 浏览器无法停止 / 删除账号后无法再打开登录窗口

**现象**：点「⏹️ 停止 Epic」无反应；删掉账号重建后，点「打开可见浏览器登录」也打不开。
截图佐证：账号列表已空（「还没有 Epic 账号」），但浏览器状态仍显示「等待登录 / 账号：329663911」，且停止按钮一直存在。

**根因 1：`closeLoginWindow()` 没有超时，而且先关浏览器、后释放锁。**
`src/core/epic.js:283-295`
```js
await this.loginContext.close().catch(() => {});   // 无 timeout，Firefox 卡住就永不返回
this.loginContext = null;                          // 永远执行不到
...
firefoxSlotLock.release(this.loginSlotOwner);      // 锁泄漏，后续所有 Epic 浏览器操作被永久挡住
```
- `stop()` 会走到这里 → 请求挂住 → 前端按钮一直转（前端 `stopEpicTask` 的 fetch 也没有超时，`app.js:1207`）
- `openLoginWindow()` 开头也会 `await this.closeLoginWindow()` → 新开登录窗口同样挂住，表现为「无法打开浏览器」

**根因 2：同样的「先 close 后释放锁」模式还有 3 处**，任一处 close 挂住都会泄漏 `firefoxSlotLock`：
`epic.js:363-365`（指纹自检）、`epic.js:1144-1145`（会话校验）、`epic.js:1257-1262`（账号领取）。

**根因 3：删除账号完全不通知 EpicManager。**
`src/web/server.js:957` 只调 `configManager.deleteEpicAccount()`，`src/config.js:434-446` 只删配置 + `fs.rmSync` 删 profile 目录。
于是：登录窗口继续开着、`loginAccountId` 指向已删除账号、锁不释放、UI 继续显示已删账号的「等待登录」；
而且 `rmSync` 在 Firefox 仍占用该 profile 时执行，可能失败或留下不一致状态。

**修复方向**
- 给所有 `context.close()` 加超时（例如 15s），超时后强制继续
- 状态清理与锁释放放进 `finally`，不要排在 close 之后
- `stop()` 直接清空 `loginContext` / `loginAccountId` / 锁，把 close 变成「尽力而为」的后台动作
- 删除账号时先 `epicManager.closeLoginWindow()` 并等待释放锁，再删配置与 profile
- 前端 `stopEpicTask` 的 fetch 加超时与「已发出停止指令」的兜底提示

**验证方式**：新增单测模拟 `context.close()` 永不 resolve，断言 `stop()` 仍能返回、锁已释放、`loginContext` 已清空。

### P1 — 点击「每日活动集 (Daily Set)」卡片进度不涨

**根因：`runTaskAction` 根本没有 `dailySet` 分支，请求掉进了通用打孔卡分支。**
- Daily Set 卡片的 key 是 `dailySet`（`src/core/taskManager.js:45`），前端直接用 `stats.tasks` 的 key 作为 `taskKey`（`app.js:1849`）
- `runTaskAction` 只有 `sign` / `read` / `search` 三个分支，其余全部走 `else`（`taskManager.js:688/719/743/747`）
- `else` 里查的是 `getQuestPunchCards()`（打孔卡），而 `isDesktop` / `isHalloween` / `isMonthly` 三个判断对 `dailySet` 全为 false，于是 `quests.find(q => !q.done)` 会**随便挑一个未完成的打孔卡**去执行
- 结果：点 Daily Set 实际去推进打孔卡，Daily Set 的 0/3 当然不动

对照：完整任务流程里 Daily Set 是走 `discoverCards()` + `claimCard()` 的（`taskManager.js:985-1045`，`api.js:973` 把它归为 `dailyset` 分类），卡片点击路径完全没接这条线。

**修复方向**：为 `dailySet` 增加独立分支，复用 `discoverCards()` 过滤 `category === 'dailyset'` 后逐个 `claimCard`，只执行一轮（不循环），执行完 `syncAccountOfficialStatus` 并返回前后进度。

**验证方式**：单测覆盖「有可完成活动」「活动已全部完成」「活动未解锁」三个分支，断言只点击一次且不会误伤打孔卡。

### P1 — 点击「每日双端签入」提示移动端签到失败

**现象**：明细里出现移动端相关的失败说明，卡片仍显示「官网 App 连签 0/7 天（今日未签）」。

**根因 1（已用容器持久化数据确认，账号绑定错误）**：XDZ 的移动端 Refresh Token 实际属于另一个微软账号。
2026-10-16 直接交叉核验 `/Volumes/nvme21-189XXXX9332/docker/microsoft-rewards/data/config.json`：

| 账号 | 网页端显示名 | 网页端余额 | 同一 Refresh Token 的 DAPI 余额 |
| --- | --- | ---: | ---: |
| XDZ | dezhen xu | 450 | 663 |
| wangheqiang530@hotmail.com | 贺强 王 | 663 | 663 |
| WHQ | 贺强 王 | 51723 | 51723 |

- XDZ 的 DAPI Token 余额与 `wangheqiang530@hotmail.com` 完全一致，均为 663；与 XDZ 网页端余额相差 213。
- 对 XDZ 调用 `signApp()` 返回 `{"points":0,"offerId":"Gamification_Sapphire_DailyCheckIn","isDuplicate":false,"balance":663}`，证明请求签到了 `wangheqiang530@hotmail.com`，不是 XDZ。
- 因此 XDZ 的 `必应应用连续打卡` 会一直停留在 0/7。修复不能只重试接口，必须在配置向导中为 XDZ 重新完成移动端授权，并绑定回 `dezhen xu`。

**根因 2（诊断性缺陷，确凿）**：`getAppCheckInStatus()` 只读取 `/earn` 旧数据，而当前权威状态在 `/dashboard`。
`src/core/api.js:639-662`
- 2026-10-15 20:22 的日志中，`/dashboard` 同步显示 XDZ 已完成 2/7 天，但签到后的 `getAppCheckInStatus()` 从 `/earn` 读到 0/7，于是误报「App 端签到未生效」。
- `getRewardsInfo()` 已改为合并 `/earn` + `/dashboard`，但 `getAppCheckInStatus()` 没有同步修正，导致同一次执行里前后状态互相矛盾。
- 修复方向：让 `getAppCheckInStatus()` 复用 `getRewardsInfo().streaks.bingapp`，或至少以 `/dashboard` 为优先、`/earn` 仅作兜底。

**根因 3（错误呈现，确凿）**：`sign` 分支把每一处失败都吞成布尔/null，用户看不到真实原因。
`src/core/taskManager.js:694-708`
```js
const tokenOk = await authManager.refreshToken(false, acc.id).catch(() => false);
if (tokenOk) {
  const appRes = await rewardsApi.signApp().catch(() => null);
  ... 否则 → 'App 端签到未返回明确结果'
} else {
  result.details.push('移动端 Token 未就绪，跳过 App 签到');   // ← 与「接口报错」混为一谈
}
```
- `signApp()` 内部任何异常都只写日志并返回 `null`（`api.js:716` 打「🔴 App 签入异常」）
- 前端徽章无条件显示绿色的「执行完成」（`app.js:1155`），**部分失败被呈现为成功**

**修复方向**
- 在卡片动作执行前做移动端 Token 归属校验；余额不一致时直接提示「移动端授权绑定到了其他账号」，不要把它当成普通签到失败
- 区分并如实上报：Token 缺失 / Token 刷新失败 / Token 归属错误 / 接口异常 / 已签到，五类分别给不同文案
- `signApp()` 返回结构化错误而不是 `null`，把失败原因带回到弹窗
- 前端在存在失败明细时不要用绿色「执行完成」，改用警告态

**验证方式**
- 单测覆盖五类分支的文案与徽章状态
- 增加 Token 余额与网页端余额不一致的回归测试，断言不会把签到算到当前账号
- 为 XDZ 重新授权后，实测 DAPI 余额应与网页端余额一致，且 `必应应用连续打卡` 能推进

## 已完成于 v1.7.3

- [x] 修复「有新版却不提示更新」：更新检查改读 tags 取语义化版本最大值，CI 打 tag 时自动创建 GitHub Release。
- [x] 更新检查失败不再伪装成「已是最新」，如实显示失败原因。
- [x] 修正 Cookie 向导文案：改为 `cn.bing.com`，并删除「`KievRPSSecAuth` 可替代 `_U`」的错误承诺。
- [x] Epic 新增「自动领取时间」设置；到点前一律暂停，容器重启不再立刻执行。
- [x] Epic 登录窗口改用干净会话 + 独立临时 profile，不注入已失效的旧凭据。
- [x] `navigator.webdriver` 补丁的 getter `toString` 对齐为 native，消除可识别痕迹。
- [x] WebGL 仅在软件渲染时替换为常见核显标识，真机 GPU 保持原值。
- [x] 新增「🔍 指纹自检」与「粘贴会话」兜底入口。

### v1.7.3 遗留 / 待验证

- [ ] 在真实 Docker 环境验证：指纹自检在 Xvfb 下是否报 llvmpipe（若报，说明 Mesa 未生效需继续排查）。
- [ ] 观察 Epic 登录在干净会话下是否仍被安全检查拦截；若仍拦截，考虑给容器固定更大的窗口尺寸/加入音频设备等桌面化特征。
- [ ] Cookie 向导的 `cn.bing.com` 改动需要真实账号验证一次：从 `cn.bing.com` 导出的 Cookie 是否稳定包含 `_U`。

## 已完成于 v1.7.2

- [x] 定位「内置浏览器完成人机验证后提示错误回复」：Epic 登录页风控采集到自相矛盾的 Firefox 指纹。
- [x] 移除 Chromium 专用 stealth 注入（`window.chrome`、Chrome PDF 插件列表、`navigator.languages`/`hardwareConcurrency` 等伪造项）。
- [x] UA 版本号改为从浏览器自身 `application.ini` 读取，不再写死 `rv:127.0` 伪装 Windows。
- [x] 移除 `webgl.disabled`，镜像补 Mesa 软件渲染，让 Xvfb 下 WebGL 真实可用。
- [x] 镜像补充 `fontconfig` 与常用字体，避免字体缺失导致页面满屏乱码。
- [x] 新增 `test/firefoxFingerprint.test.js` 防指纹自相矛盾回归。

### v1.7.2 遗留 / 待验证

- [ ] 在真实 Docker 环境重跑一次 Epic 登录，确认人机验证后能正常进入并保存凭据。
- [ ] 若仍被风控拦截，下一步考虑为 Xvfb 提供固定尺寸的「真实窗口」外观，或改用带 GPU 的宿主直通。

## 已完成于 v1.7.1

- [x] noVNC 通过现有 `5308` 端口反向代理，不再依赖宿主机额外映射 `6080`。
- [x] Epic 可见浏览器改为 WebUI 内嵌小窗，登录弹窗内可直接完成登录与保存。
- [x] Epic 账号登录改为内置可见 Firefox，登录后直接保存 storageState 与持久化 profile，无需复制 Cookie。
- [x] 登录窗口占用期间持有 Firefox 资源锁，领取/校验会快速让路，避免同一 profile 被并发打开。
- [x] noVNC 静态资源与 WebSocket 升级均纳入 Basic 鉴权，避免绕过密码操作已登录浏览器。
- [x] 登录窗口超过 `EPIC_LOGIN_TIMEOUT_MIN`（默认 30 分钟）未保存时自动关闭并释放资源。

### v1.7.1 遗留 / 待验证

- [ ] 在真实 Docker 环境（含 Xvfb + websockify）验证内嵌小窗能连上画面并完成一次真实 Epic 登录。
- [ ] 验证反向代理（HTTPS/WSS）场景下 noVNC 升级请求能正常透传。

## 已完成于 v1.7.0

- [x] 所有系统弹窗改为网页弹窗。
- [x] 微软签到任务卡片支持点击立即执行。
- [x] Epic 操作弹窗增加实时浏览器日志窗口。
- [x] Epic 切换 Firefox 持久化 profile、stealth 与可见浏览器。

---

## 历史记录：v1.7.0 计划

### 1. 所有系统弹窗改为网页弹窗

- 全量审计前端 `alert`、`confirm`、`prompt`，全部替换为统一网页对话框或网页提示。
- 涉及但不限于：配置中心、通知测试、账号管理、任务执行、停止/删除确认、错误提示与成功提示。
- 网页弹窗统一支持标题、正文、明细、进度、成功/警告/失败状态，以及必要的确认/取消操作。
- 长时间操作不阻塞页面，保留后台运行或可关闭后继续查看状态的交互。

### 2. 微软签到任务卡片支持点击立即执行

- 每个账号的今日任务进度卡片改为可点击卡片，并提供明确的悬停/点击反馈。
- 点击卡片后，立即执行该卡片对应的一次功能，并弹出网页结果弹窗。
- 双端签入卡片：
  - 先检查当前签到状态。
  - 若未签到，只执行一次签到。
  - 若已签到，直接返回“今日已签到”的结果。
- 新闻资讯阅读卡片：
  - 点击后立即阅读一次。
  - 阅读完成后刷新真实进度，验证积分是否到账。
  - 在弹窗中展示阅读前后进度、积分变化和最终结果。
- 活动任务/打孔卡卡片（例如万圣节活动）：
  - 点击后先刷新任务状态。
  - 若存在可继续点击完成的任务按钮，只执行一次任务点击。
  - 若全部按钮已灰色、不可点击或未解锁，弹窗明确提示“当前暂无可完成的任务”。
  - 执行后再次刷新任务状态，并在弹窗展示进度变化。

### 3. 通用约束

- 同一账号同一时间只允许一个卡片动作执行，避免重复点击与浏览器/账号上下文冲突。
- 执行期间显示卡片级加载状态，完成后更新卡片进度与积分看板。
- 所有卡片动作结果统一通过网页弹窗展示，不再使用系统弹窗。
- 增加单元测试与真实浏览器冒烟验证，覆盖已签到、未签到、可完成任务、不可完成任务四类分支。

### 4. Epic 操作弹窗增加实时浏览器日志窗口

- 在 Epic 校验、领取、更新会话等操作弹窗中增加实时日志窗口。
- 实时展示当前浏览器动作，例如：初始化持久化配置、打开商城、检测人机验证、等待页面、点击获取、等待结账按钮、提交订单、核验结果等。
- 长时间等待时持续更新“当前正在等待什么”，避免用户误判为网页卡死。
- 日志窗口支持自动滚动，并在任务完成后保留本次操作的关键日志摘要。
- 正常完成后弹窗只保留“关闭”按钮；停止、后台运行按钮仅在任务执行期间显示。
