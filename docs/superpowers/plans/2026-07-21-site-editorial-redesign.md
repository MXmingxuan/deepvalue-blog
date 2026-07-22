# Deep Value Editorial Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the transitional site UI with the approved cinematic commodities hero and warm-paper editorial publication across homepage, domain, log, archive, about, and detail pages.

**Architecture:** Keep the published-only content foundation unchanged. Establish a reusable token system in OpenDesign and the production layout, use one original wide hero asset, then rebuild page composition around editorial sections and a chronological log stream. No fake articles or market data may be invented to fill empty states.

**Tech Stack:** Astro 6.1, Astro content collections, CSS, existing Space Mono font package, system Chinese serif stack, original generated PNG asset.

## Global Constraints

- Visual direction: cinematic macro hero plus warm-paper editorial body.
- Palette: deep charcoal, warm paper, oxidized copper, muted olive.
- Typography: Chinese serif for display and reading; Space Mono for metadata.
- The user-supplied reference image must never be copied, shipped, traced, or used as an image-generation input.
- Use the approved original generated commodities panorama as the source for the
  production hero. The repository derivative is
  `public/images/brand/commodities-macro-hero.avif` (source PNG SHA-256:
  `ea97f6ebe3fa7503171aa0974f0e6a0832a6c05fa7d742fd47b93956e38a3c64`;
  production AVIF SHA-256:
  `822acb297d3c4dead2de9dd0391cb845f6246d58c4da34ef86043439ba7763f3`).
- Preserve published-only collection access, existing 滨化 URL, Vercel redirects, and all approved routes.
- Do not invent content, prices, statistics, articles, or logs.
- Research logs may be long; short logs render fully in lists and long logs link to the same permanent detail route.
- Mobile touch targets are at least 44px.

---

### Task 1: Canonical Editorial Design System

**Files:**
- Create: `opendesign/design-systems/deep-value-editorial/SKILL.md`
- Create: `opendesign/design-systems/deep-value-editorial/README.md`
- Create: `opendesign/design-systems/deep-value-editorial/tokens/colors_and_type.css`
- Create: `opendesign/design-systems/deep-value-editorial/brand/style-notes.md`
- Create: `opendesign/design-systems/deep-value-editorial/brand/voice-and-tone.md`
- Create: `opendesign/mockups/deep-value-editorial/homepage.html`
- Modify: `opendesign/manifest.json`
- Create: `public/images/brand/commodities-macro-hero.avif`

**Interfaces:**
- Produces production CSS variables named `--color-ink`, `--color-paper`, `--color-copper`, `--color-olive`, `--font-editorial`, `--font-data`, and type-scale variables `--step--1` through `--step-5`.

- [ ] Encode the approved original image as the production-ready
  `public/images/brand/commodities-macro-hero.avif`; do not modify or copy the
  user's reference image.
- [ ] Write canonical raw and semantic tokens to the required OpenDesign token path. Use `#0b0c0b` ink, `#d8cfbd` paper, `#a46743` copper, `#777b68` olive, and low-contrast border colors derived with `color-mix`.
- [ ] Document the macro/commodities mood, imagery restrictions, serif/mono pairing, square editorial rules, minimal radii, restrained motion, and factual voice.
- [ ] Create one high-fidelity static homepage mockup using the real hero asset and the existing 滨化 article title; do not add fake research entries.
- [ ] Rebuild `opendesign/manifest.json` so it lists the homepage mockup and all design-system files.
- [ ] Verify all referenced files exist and the mockup contains no URL to the temporary reference image.
- [ ] Commit with `git commit -m "design: define Deep Value editorial system"`.

---

### Task 2: Production Shell and Homepage

**Files:**
- Modify: `src/layouts/Base.astro`
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes tokens and `/images/brand/commodities-macro-hero.avif` from Task 1.
- Preserves the existing `Base` props: `title` and optional `description`.

- [ ] Replace the current black-grid shell with a two-surface system: charcoal header/hero context and warm-paper reading surface.
- [ ] Use a sticky or static editorial header with wordmark, approved navigation, visible keyboard focus, and 44px mobile targets.
- [ ] Define the production tokens in `Base.astro` using the Task 1 values; remove Bebas Neue and Inter usage from the rendered system while retaining Space Mono.
- [ ] Rebuild the homepage with:
  - full-bleed cinematic hero using the original panorama, dark overlay, publication eyebrow, approved positioning statement, and links to Investment Research and Research Log;
  - a warm-paper issue bar showing only structural labels, not fabricated live prices;
  - one featured published article section;
  - published investment articles;
  - recent research logs or an intentional empty state;
  - AI and Technology module or an intentional empty state;
  - lower-emphasis Beyond the Boundary module.
- [ ] Remove all old four-lane homepage cards and legacy topic links.
- [ ] Add one restrained hero entrance animation and respect `prefers-reduced-motion`.
- [ ] Run `npm test` and `npm run build`; verify the homepage contains no draft titles and no legacy section URLs.
- [ ] Commit with `git commit -m "feat: rebuild editorial homepage"`.

---

### Task 3: Editorial Collections, Log Stream, and Detail Pages

**Files:**
- Modify: `src/components/EntryList.astro`
- Modify: `src/pages/investment/index.astro`
- Modify: `src/pages/ai/index.astro`
- Modify: `src/pages/beyond/index.astro`
- Modify: `src/pages/research-log/index.astro`
- Modify: `src/pages/archive/index.astro`
- Modify: `src/pages/about/index.astro`
- Modify: `src/pages/blog/index.astro`
- Modify: `src/pages/blog/[slug].astro`
- Modify: `src/pages/projects/index.astro` only as needed to remain readable in the new Base surface.

**Interfaces:**
- Keeps `EntryList` props `entries` and `emptyText` and query filtering behavior from the foundation.
- Keeps every detail URL `/blog/<publish_id>/`.

- [ ] Turn `EntryList` into an editorial ruled list with domain/format/date metadata, tag chips without pill-heavy styling, and preserved URL filtering behavior.
- [ ] Give domain pages a shared publication header, concise domain description, section index, article/log grouping, and honest empty states.
- [ ] Render Research Log as a chronological stream: timestamp rail, domain/topic/hashtags, full short content excerpt, and `阅读全文` for longer entries. With zero logs, explain that published logs will appear here instead of showing fake cards.
- [ ] Style Archive as a compact chronological index.
- [ ] Expand About with the approved publication positioning, scope, and distinction between articles and research logs.
- [ ] Restyle detail pages for warm-paper long reading, thesis block, metadata, tables, code, blockquotes, images, and back navigation. Do not change Markdown bodies.
- [ ] Preserve client-side `section/topic` filtering and the filtered-empty message.
- [ ] Verify desktop and mobile layouts in the local browser at homepage, investment, research log, and the published article route; check console errors.
- [ ] Run `npm test`, `npm run build`, all published/draft route assertions, and `git diff --check` excluding the accepted unchanged article-body whitespace.
- [ ] Commit with `git commit -m "feat: apply editorial design across research pages"`.

---

## Completion Gate

- Homepage visibly matches the approved Scheme 1 rather than the old dark grid.
- All public pages use the same editorial system and remain usable on mobile.
- The supplied reference artwork is absent from the repository.
- The original production hero is present and optimized enough for a web hero.
- No fake content is introduced.
- Six Node tests and the Astro production build pass.
- Draft routes remain absent and the 滨化 route remains stable.
- Visual browser review reports no blocking defects or console errors.
