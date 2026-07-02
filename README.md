# Deep Value Research

Astro static research site for long-form industry notes. The current focus is:

- 氟化工研究
- AI 数据中心研究

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
sector: "fluorochemical" # fluorochemical | ai-data-center | other
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
- `/fluorochemical-research/` - 氟化工研究
- `/ai-data-center-research/` - AI 数据中心研究
- `/blog/` - All research notes
- `/blog/[slug]/` - Article detail

## Architecture

- Astro content collections validate article metadata.
- Markdown files are the source of truth.
- Pages are statically generated for fast deployment and simple hosting.
