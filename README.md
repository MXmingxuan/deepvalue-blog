# Deep Value Research

Astro static research site for long-form industry notes. The current focus is:

- 化工研究
- AI 基础设施研究
- 航运与船舶研究

## Commands

```bash
npm.cmd run dev
npm.cmd run build
npm.cmd run preview
```

## Content

Research articles live in:

```text
src/content/blog/
```

Each article is a Markdown file with structured frontmatter. Use `sector` to decide which topic page receives the article:

```yaml
---
title: "文章标题"
date: 2026-07-02
description: "页面 SEO 描述"
summary: "列表页显示的摘要"
sector: "chemical" # chemical | ai-infrastructure | shipping-shipbuilding | other
research_type: "sector" # sector | company | event | memo
status: "draft" # draft | active | archived
confidence: "medium" # low | medium | high
tags: ["标签"]
categories: ["专题"]
companies: []
tickers: []
thesis: "核心判断"
---
```

## Routes

- `/` - Research homepage
- `/chemical-research/` - 化工研究
- `/ai-infrastructure-research/` - AI 基础设施研究
- `/shipping-shipbuilding-research/` - 航运与船舶研究
- `/blog/` - All research notes
- `/blog/[slug]/` - Article detail

## Architecture

- Astro content collections validate article metadata.
- Markdown files are the source of truth.
- Pages are statically generated for fast deployment and simple hosting.
