# 🎁 Microsoft Rewards Docker

**把微软积分日常，交给一台不休息的小容器。**
基于 Docker + WebUI，适合 NAS、VPS 和家用服务器。多账号管理、每日任务、浏览器登录、代理与运行计划，都在一个网页里完成。

[![Version](https://img.shields.io/badge/version-v1.10.19-blue.svg)](https://github.com/wangheqiang530/microsoft-rewards-docker/releases/tag/v1.10.19)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED.svg?logo=docker&logoColor=white)](https://www.docker.com/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

> 🍃 不用一直开着电脑，也不用守着浏览器。配好账号和计划，剩下的事情交给容器。

---

## 👀 它能做什么

- 👥 **多账号管理**：账号独立保存 Cookie、Token、代理、运行时段与任务进度。
- 🤖 **每日任务自动化**：PC 签入、移动端签到、移动端每日活动、新闻阅读、必应搜索、Daily Set、活动卡片与打孔卡。
- 🖥️ **内置浏览器登录**：在 WebUI 的 VNC 窗口中完成微软账号登录与 MFA，自动抓取 Cookie 和 OAuth 凭据。
- 🌐 **网络出口管理**：支持 HTTP / HTTPS / SOCKS5 代理，可按账号选择直连、跟随全局或指定节点。
- 📅 **小时级运行计划**：24 个一小时档位，每账号选择一个，错过或冲突一目了然。
- 📊 **可视化控制台**：账号总览、任务进度、积分趋势、实时日志、24 小时脱敏诊断日志导出、手动执行与一键停止。
- 🎮 **Epic 免费游戏**：多账号自动巡检与领取，遇到人机验证时可人工接管。
- 🔔 **消息通知**：企业微信、钉钉、飞书、Bark、PushMe、Telegram、QQ 机器人，支持独立推送代理与逐渠道代理开关。
- 💾 **数据持久化**：配置、历史、日志与浏览器会话统一保存在 `./data`。

---

## 🐳 3 分钟部署

### Docker Compose（推荐）

先准备目录和配置文件：

```bash
mkdir -p ms-rewards/data
cd ms-rewards
```

创建 `docker-compose.yml`：

```yaml
services:
  microsoft-rewards:
    image: wangheqiang/microsoft-rewards-docker:latest
    # GitHub 镜像可替换为：
    # image: ghcr.io/wangheqiang530/microsoft-rewards-docker:latest
    container_name: ms-rewards
    restart: unless-stopped
    ports:
      - "5308:5308"
    environment:
      - TZ=Asia/Shanghai
      - PORT=5308
      - VNC_ENABLED=1
      - MS_LOGIN_TIMEOUT_MIN=20
    volumes:
      - ./data:/app/data
```

启动：

```bash
docker compose up -d
docker compose logs -f
```

看到服务正常启动后，访问：

```text
http://<NAS 或 VPS 的 IP>:5308
```

### Docker Run

```bash
docker run -d \
  --name ms-rewards \
  --restart unless-stopped \
  -p 5308:5308 \
  -v "$PWD/data:/app/data" \
  -e TZ=Asia/Shanghai \
  -e VNC_ENABLED=1 \
  wangheqiang/microsoft-rewards-docker:latest
```

> 🔒 **第一次打开 WebUI 后，请先在配置中心设置访问密码，并且不要把 `5308` 端口直接暴露到公网。**

---

## 🪄 第一次使用

1. 打开右上角的 **新手配置向导**。
2. 确认网络出口：中国区账号建议使用中国大陆 IP。
3. 选择 **内置浏览器登录**，在弹出的 VNC 窗口中登录微软账号并完成 MFA。
4. 等待程序自动保存 Cookie、OAuth Token 和账号信息。
5. 点一次 **立即执行**，确认任务进度正常后，再启用自动运行计划。

如果自动登录遇到验证码，可以直接在 VNC 窗口里手动完成。VNC 本身不设置密码，访问安全由 WebUI 密码控制。

<details>
<summary>想手动填写 Cookie / Token？</summary>

- 网页 Cookie 建议从 `https://rewards.bing.com/dashboard` 获取，并确认包含 `_U=...`。
- 移动端 Token 可通过向导中的微软官方 OAuth 授权流程获取。
- Cookie 与 Token 必须属于同一个微软账号，否则移动端任务会被安全拦截。

</details>

---

## ⏰ 自动运行

- 每天提供 `00:00` 至 `23:00` 共 24 个一小时档位。
- 每个账号选择一个档位，同一档位不会被多个账号重复占用。
- 没有选择档位的账号视为暂停，不会生成自动任务。
- 定时巡检按「24 个一小时档位 + 窗口内随机启动」运行，无需配置 Cron。
- 执行中的任务可以手动停止；多账号之间默认保留安全间隔。

---

## 🧩 任务范围

| 任务 | 说明 |
| :--- | :--- |
| PC 签入 | 自动完成网页端每日签入 |
| 移动端签到 | 使用已授权的移动端身份完成 App 签到 |
| 移动端每日活动 | 按当天日期生成三张 DAPI Child offerId 并领取 30 分 |
| 移动端附加活动 | 处理 App DAPI 返回的 sapphire 附加活动 |
| 新闻阅读 | 自动阅读每日资讯任务 |
| 必应 PC 搜索 | 按官网实际配额执行，连续不涨分时自动停止 |
| Daily Set | 自动完成每日活动集 |
| 桌面专属任务 | 完成桌面端每周打孔卡 |
| 任务区打孔卡 | 自动推进当前可执行任务，并回读官网进度 |
| 浏览器中的奖励 | 处理官网实际返回的活动卡片 |
| 额外积分 | 任务收尾时检查并领取可领取的额外积分 |

> 📌 积分数量、任务入口和地区规则由微软动态调整，请以官网显示为准。

---

## 🌐 代理与地区

配置中心支持保存多套代理，并为每个账号单独选择：

- **直连**：使用容器默认网络。
- **跟随全局**：使用全局默认出口。
- **指定代理**：只让当前账号走指定节点。

每套代理都可以测试出口 IP、归属地、延迟和代理连通性。默认开启中国大陆地区保护，检测到境外出口时会阻止任务，降低国区账号触发风控的概率。

消息推送另有一套完全独立的专用代理，不复用积分任务或账号代理。可以在每个推送渠道旁单独勾选是否启用该推送代理。
消息推送中的 `socks5://` 会自动按 `socks5h://` 使用远端 DNS，避免 Telegram 等域名被容器本地 DNS 污染。Telegram 还提供不发送消息的“检测连接”按钮，可查看 Bot、Chat ID 与真实 API 延迟。

---

## 🎮 Epic 免费游戏

Epic 与微软积分使用独立账号和浏览器会话：

- 按设定时间自动检查免费游戏。
- 支持多账号、自动领取、失败重试和入库校验。
- 遇到人机验证时自动打开可见浏览器窗口，可手动完成。
- 登录、领取与校验使用独立的持久化浏览器 Profile。

---

## 🗂️ 数据目录

把宿主机的 `./data` 挂载到容器 `/app/data` 即可持久化：

| 路径 | 内容 |
| :--- | :--- |
| `data/config.json` | 账号、Cookie/Token、代理、任务与通知配置 |
| `data/stats.json` | 当前任务进度和积分快照 |
| `data/history.json` | 历史积分与趋势数据 |
| `data/sessions/` | 按账号隔离的浏览器会话 |
| `data/app.log` | 运行日志，带大小轮转 |
| `data/fonts/windows/` | 可选 Windows 字体目录 |

迁移服务器时，打包整个 `data` 目录即可。
删除 `data/sessions/` 会要求账号重新建立浏览器会话，但不会删除积分历史。

> 🔐 `config.json` 和 `sessions/` 包含敏感登录信息，请限制文件权限，不要上传到公开网盘或仓库。

---

## 🛠️ 本地开发

需要 Node.js 20+：

```bash
git clone https://github.com/wangheqiang530/microsoft-rewards-docker.git
cd microsoft-rewards-docker
npm install
npm start
```

运行测试：

```bash
npm test
```

调试时可以隔离数据目录，避免改动正式配置：

```bash
MSR_DATA_DIR=/tmp/msr-dev npm start
```

---

## ❓ 常见问题

<details>
<summary><strong>提示“非中国大陆 IP，已自动停止”怎么办？</strong></summary>

给账号配置一个可用的中国大陆代理，并在配置中心测试出口 IP。确认节点归属地为中国大陆后，再重新执行账号体检。

</details>

<details>
<summary><strong>Cookie 失效了怎么办？</strong></summary>

重新打开内置浏览器登录，或手动更新 Cookie。PC 搜索依赖 Cookie 中的 `_U`，没有它通常无法正常计分。

</details>

<details>
<summary><strong>VNC 窗口打不开或白屏怎么办？</strong></summary>

先确认容器运行时带有 `VNC_ENABLED=1`，再查看 `docker compose logs -f`。如果启用了核显，请确认宿主机存在 `/dev/dri`；不确定时先保持软件渲染。

</details>

<details>
<summary><strong>如何升级？</strong></summary>

```bash
docker compose pull
docker compose up -d
```

升级前建议备份整个 `data` 目录。

</details>

---

## ⚠️ 使用提醒

- 本项目仅用于管理你自己的微软账号，请遵守微软服务条款与当地法律法规。
- 自动化操作仍可能受到官网改版、网络环境、地区限制或风控策略影响，无法保证每次都获得全部积分。
- 不建议高频运行、频繁切换 IP 或在多个地区同时登录同一账号。
- 对外提供服务时，请使用强密码、反向代理和 HTTPS，并限制来源 IP。

如果这个项目帮你省下了每天点来点去的时间，欢迎点一个 ⭐。
