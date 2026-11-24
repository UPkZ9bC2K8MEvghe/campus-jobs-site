# 校招信息查询 campus-jobs

26/27 届校招与实习岗位聚合站：汇总近 8000 家企业官方招聘渠道的岗位，支持按城市、行业、企业性质、学历、批次筛选，附带面试题库、面经、央国企名录以及每日新增的 RSS / Sitemap。

- 正式站（Cloudflare Pages）：<https://campus-jobs.pages.dev>
- GitHub Pages 镜像：<https://upkz9bc2k8mevghe.github.io/campus-jobs-site/>
- 面向大模型的站点索引：[`llms.txt`](llms.txt)

## 特性

- **岗位聚合**：校招 8000+ 行、实习 1900+ 行，默认只展示未截止投递的岗位。
- **多维筛选**：城市 / 行业 / 企业性质 / 学历 / 届别 / 截止时间，筛选结果可分享（URL 参数）。
- **企业静态页**：每家企业一个详情页（共 7500+），方便搜索引擎收录。
- **求职资料**：60+ 高频面试题与参考答案、12 家企业面经。
- **离线可用**：Service Worker 缓存页面与数据，可安装为 PWA。
- **SEO / AI 友好**：sitemap、RSS、`robots.txt`、`llms.txt`、结构化数据。
- **每日更新**：私有仓库的 GitHub Actions 定时抓取 → 校验 → 构建 → 部署，并回写数据。

## 目录结构

```
index.html                单页应用入口
assets/                   app.js / styles.css
data/                     岗位、实习、题库、面经、统计等 JSON（v2 压缩格式）
scripts/
  fetch-official.mjs      官方招聘站抓取（Playwright + HTTP）
  export-data.mjs         飞书多维表格 / 文档导出与压缩
  validate-data.mjs       数据一致性校验
  build-*.mjs             订阅、题库、静态站、企业页生成
  rewrite-site-url.mjs    GitHub Pages 镜像的站点地址改写（仅 CI 使用）
.github/workflows/
  fetch-campus-jobs.yml   私有仓库的每日抓取 + Cloudflare 部署
  pages.yml               本仓库的 GitHub Pages 构建与发布
```

## 本地运行

要求 Node.js 20+。

```bash
npm install
npm run fetch      # 可选：抓取最新岗位（需要 Playwright 浏览器）
npm run build      # 校验 + 生成 feeds / 题库 / dist 静态站
npm run preview    # 本地预览 dist
```

单独执行：

```bash
npm run validate        # 数据校验
npm run build:feeds     # 生成 feeds.xml
npm run build:questions # 生成题库
npm run merge           # 仅合并抓取分片
```

## 部署

- **GitHub Pages**：推送到 `master` 后由 `.github/workflows/pages.yml` 自动构建 `dist/` 并发布；
  构建时会把 canonical / sitemap 中的正式站地址改写为 Pages 地址。
  每天 02:20 UTC 还会自动从正式站拉取最新公开数据（`scripts/sync-public-data.mjs`）后重建，
  因此镜像会跟随每日更新，不需要额外 secret。
- **Cloudflare Pages**（正式站）：由私有仓库的定时工作流执行
  `wrangler pages deploy dist --project-name campus-jobs`。

本仓库是公开镜像，定时抓取工作流在此仓库中会自动跳过。

## 数据说明

数据整理自企业官方招聘网站与公开信息，可能存在延迟或遗漏；投递前请以企业官方最新公告为准。
引用本站数据请注明来源，并保留上述提示。
