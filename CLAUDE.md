# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# DEEP VALUE Blog

Hugo-based personal blog focused on investment analysis, AI, and analytical thinking. Content is primarily Chinese.

## Commands

```bash
# Development server with drafts
hugo server -D

# Build static site
hugo

# Publish article from Obsidian markdown source
./scripts/publish.sh <markdown文件路径> [--slug <自定义别名>] [--date <YYYY-MM-DD>]

# Git sync (add, commit, push)
./scripts/sync.sh "提交信息"
```

## Architecture

### Configuration
- `hugo.yaml` - Primary config (complete site configuration including params, menus, hero section, about, projects, contact)
- `hugo.toml` - Secondary config (older, uses `bear-style` theme)
- Both exist; `hugo.yaml` is the active configuration

### Theme
- `themes/hugo-profile` - Main theme (configured in `hugo.yaml`)
- `themes/bear-style` - Custom minimal theme inspired by Bear Blog

### Content Structure
- `content/posts/` - Published blog posts
- `content/blogs/` - Source/blog drafts (mirrors posts/)
- `content/about.md` - About page
- `content/contact.md` - Contact page
- `content/projects/_index.md` - Projects page
- `static/images/` - Post images organized by slug

### Publish Workflow
1. Write in Obsidian with wiki-links (`![[image.png]]`)
2. Run `publish.sh` to:
   - Convert wiki-links to standard markdown
   - Copy images to `static/images/<slug>/`
   - Generate frontmatter (title, date)
   - Output to `content/posts/<slug>.md`

### Taxonomy
- Categories: `/categories/`, `/categories/<name>/`
- Tags: `/tags/`, `/tags/<name>/`

Frontmatter format:
```yaml
---
title: "文章标题"
date: 2024-01-01T00:00:00+08:00
categories: ["分类1"]
tags: ["标签1"]
---
```

## Notes

- Site: https://deepvalue.space/
- Author: 宋明轩 (mingxuan)
- Chinese content with English configuration
- `sync.sh` auto-generates commit timestamp if no message provided
