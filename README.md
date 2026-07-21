# Deep Value Research

Astro static research site for published investment research, AI and technology notes, research logs, and essays beyond the core research domains.

## Commands

```bash
npm run dev
npm test
npm run build
npm run preview
```

## Content

Published articles and research logs live in:

```text
src/content/entries/
```

Each entry is a Markdown file with structured frontmatter. This is the minimal published article:

```yaml
---
title: 文章标题
publish_id: stable-public-slug
domain: investment
section: commodities
topic: copper
format: article
status: published
published_at: 2026-07-21
summary: 列表与 SEO 摘要
source_type: original
tags: [铜]
commodities: [铜]
companies: []
tickers: []
---
```

Only `status: published` entries appear in lists or receive `/blog/<publish_id>/` routes. Draft and archived entries remain in the content collection but are not public.

## Routes

```text
/investment/    投资研究
/ai/            AI 与技术
/research-log/  研究日志
/beyond/        边界之外
/archive/       全部已发布内容
/about/         关于 Deep Value
/blog/<id>/     文章或日志详情
```

Legacy research-section URLs redirect to the corresponding current information-architecture routes.

## Release verification

Run the full suite before publishing:

```bash
npm test
npm run build
test -f 'dist/blog/滨化股份-g5-级电子级氢氟酸真业务小体量与第二曲线验证/index.html'
test ! -e 'dist/blog/ai数据中心研究占位'
test ! -e 'dist/blog/氟化工研究占位'
test ! -e 'dist/blog/能源研究占位'
for route in investment ai beyond research-log archive about; do test -f "dist/$route/index.html"; done
git diff --check
```

## Architecture

- Astro content collections validate entry metadata.
- Markdown files are the source of truth.
- Pages are statically generated for fast deployment and simple hosting.
