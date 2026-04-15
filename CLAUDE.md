# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# DEEP VALUE Blog

Astro-based personal blog focused on investment analysis, AI, and analytical thinking. Content is primarily Chinese.

## Commands

```bash
# Development server
npm run dev

# Build static site
npm run build

# Sync to GitHub Pages
npm run sync
```

## Architecture

### Project Structure
- `src/content/blog/` - Blog posts (Markdown)
- `src/content.config.ts` - Content collection schema
- `src/layouts/Base.astro` - Base layout
- `src/pages/` - Astro pages
- `public/` - Static files for GitHub Pages
- `dist/` - Build output

### Content Schema
```typescript
{
  title: string;
  date: Date;
  description?: string;
  tags?: string[];
  categories?: string[];
}
```

### Key Routes
- `/` - Homepage with recent posts
- `/blog` - Blog list
- `/blog/[slug]` - Individual posts

## Deployment
Site deploys to GitHub Pages. Push to main triggers automatic build.

## Notes
- Site: https://deepvalue.space/
- Author: 宋明璇 (mingxuan)
- Chinese content with simple styling
