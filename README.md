# TactiCall Grant Radar

一个静态网页 + GitHub Actions 组成的资助监控看板。部署在 GitHub Pages 上运行，
每天自动抓一遍资助信息，新出现的会高亮，点一个资助可以生成一张甘特图来跟踪申请进度。

## 目录结构

```
index.html            资助看板（首页）
keywords.html          关键词 / 抓取来源 / GitHub 连接设置
tracker.html            单个资助的任务清单 + 甘特图
assets/                 样式和前端逻辑（纯原生 JS，没有构建步骤）
data/
  keywords.json         爬虫用的关键词表
  sources.json           爬虫每天要检查的网址列表
  grants.json             当前的资助列表（人工整理的 + 爬虫抓到的都在这里）
  trackers.json           （首次使用「同步到 GitHub」后才会出现）每个资助的任务进度
  last-crawl.json         （首次跑完 Action 后才会出现）最近一次抓取的运行记录
scripts/crawl.mjs       每日抓取脚本（Node，跑在 GitHub Actions 里）
.github/workflows/daily-crawl.yml   每天定时触发抓取脚本的 Action
```

## 部署步骤（10 分钟）

1. 在 GitHub 建一个新仓库（比如 `tacticall-grants`），把这整个文件夹的内容传上去
   （直接在网页上拖拽上传，或者用 `git push` 都行）。
2. 仓库 Settings → Pages → Source 选 **Deploy from a branch**，branch 选 `main`，
   目录选 `/ (root)`，保存。等一两分钟，网址会是
   `https://<你的用户名>.github.io/<仓库名>/`。
3. 仓库 Settings → Actions → General，确认 "Workflow permissions" 是
   **Read and write permissions**（这样每日抓取脚本才能把结果提交回仓库）。
4. 完事了。`.github/workflows/daily-crawl.yml` 会在每天 UTC 06:00（大概是北京时间
   14:00）自动跑一次；也可以随时去仓库的 Actions 标签页，点
   `Daily grant crawl` → `Run workflow` 手动跑一次，不用等到第二天。

本地想预览的话不要直接双击打开 `index.html`——浏览器会因为同源策略拒绝读取
`data/*.json`。用一条命令起个本地服务器就行：

```
python3 -m http.server 8000
# 然后打开 http://localhost:8000
```

## 四个功能是怎么做到的

**1. 每天自动更新**
GitHub Pages 本身是纯静态托管，没法自己"每天跑一次"；真正干活的是
`.github/workflows/daily-crawl.yml` 这个 GitHub Actions 定时任务——它每天启动一台
临时虚拟机，跑 `scripts/crawl.mjs`，把新结果写回 `data/grants.json` 并直接
`git push`。GitHub Pages 看到仓库更新了，会自动重新发布，你的网页第二天打开就是
新内容，全程不需要你做任何事。

**2. 关键词入口**
`keywords.html` 页面可以直接增删关键词/抓取来源。保存的时候会通过 GitHub 的
Contents API 把改动直接提交回仓库（需要你自己生成一个 Personal Access
Token，见页面上的说明；这个 token 只存在你自己浏览器的 localStorage 里，
只会直接发给 `api.github.com`）。不想用 token 也完全可以——直接去 GitHub 网页版
编辑 `data/keywords.json` / `data/sources.json` 效果是一样的。

**3. 新资助高亮**
爬虫每次找到一条从没见过的资助，会给它标 `firstSeen` 和 `isNew: true`；
看板会给最近 5 天内新增的条目加黄色边框和「NEW」标签，5 天后自动褪色，不用手动清理。

**4. 甘特图追踪**
看板上每个资助卡片有个「开始跟踪申请」按钮，会带着这条资助的 id 跳到
`tracker.html`。可以一键套用默认的 7 步申请模板（阅读要求 → 起草方案 → 整理预算 →
收集材料 → 内部审阅 → 修改定稿 → 提交），也可以自己加/删/改任务，时间线会实时画成
一条甘特图（纯手写的 CSS/JS，没有依赖任何外部图表库，不用担心哪天某个 CDN 挂了）。
默认存在这台设备的浏览器里；点「同步到 GitHub」可以存进仓库的
`data/trackers.json`，换电脑也能看到。

## 关于爬虫，说几句实话

`scripts/crawl.mjs` 做的事情是：把每个来源网址当纯 HTML 抓下来，按标题
（h1–h4）切成一段一段，看哪一段的文字里出现了关键词，把匹配到的段落当作
"线索"塞进 `grants.json`，deadline 是用正则从文字里猜的，不保证准。这意味着：

- 大部分来源**没有用任何搜索 API**，抓取质量完全取决于 `data/sources.json` 里的
  网址本身写得干不干净。政府网站（gov.uk）通常不需要 JS 就能读到完整内容，效果
  最好；一些机构官网是前端渲染的（比如纯 React/Vue 做的官网），这种页面 Node 的
  `fetch()` 只能拿到空壳 HTML，基本抓不到东西——这是已知限制，不是 bug。
  想覆盖某个抓不到的重要来源，最可靠的办法还是定期手动看一眼。
- `data/sources.json` 里另外有两条 `"type": "search"` 的来源（一条通用资助/加速器
  搜索，一条限定 `site:linkedin.com` 的 LinkedIn 站内搜索），用来兜底那些没被
  收进上面固定网址列表、但可能出现在别的网站或 LinkedIn 帖子里的资助信息。这两条
  没法用普通 `fetch()` 抓——实测直接爬 Google / Bing / DuckDuckGo 的搜索结果页
  一定会被反爬虫机制拦下来（验证码或"unusual traffic"页面），LinkedIn 本身则是
  未登录直接返回登录墙，所以改成调用 **Brave Search API**（有免费额度，每月
  2000 次查询）。要启用它们，去 [Brave Search API](https://api.search.brave.com/)
  免费注册拿一个 key，然后在仓库 Settings → Secrets and variables → Actions →
  New repository secret，新建一个名叫 `BRAVE_API_KEY` 的 secret 填进去就行。
  不设置这个 secret 也完全不影响其他来源正常抓取——这两条搜索来源只会在当天的
  运行记录里显示"跳过"，不会报错中断整个流程。
- 每条自动抓到的记录都标着 `source: "auto"` 和 `verified: false`，看板上会显示
  「待核实」——**提交申请前务必点进原文核实截止日期和资格条件**，不要直接信爬虫。
- 想让某条抓到的记录"转正"：在看板上点「编辑」，把日期/标签核实好之后勾上
  「已人工核实」保存，之后爬虫再抓到同一条就不会再覆盖你确认过的内容了。
- 45 天没有再抓到的自动条目会被标成"半透明"（`stale`），提示你它可能已经下线了，
  但不会被删除，你可以自己判断要不要清掉。

## 想扩展的话

- 想要更精准的抓取：可以把某个特别重要的来源单独写一段自定义解析逻辑
  （`scripts/crawl.mjs` 里 `crawlSource()` 就是入口），或者接一个付费搜索
  API（Bing/SerpAPI 之类），把 API key 存进仓库的 Actions Secrets 里读取。
- 想要邮件/微信提醒：可以在 `daily-crawl.yml` 里，`git push` 那一步之后加一步，
  检测 `data/grants.json` 是否有新的 `isNew:true` 条目，调用一个 Webhook
  （比如 Server 酱、企业微信机器人）推送。
