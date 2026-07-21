# Deep Value Editorial

Deep Value is a professional personal publication centered on investment, trading, and commodity research, with AI applications and research workflows as a secondary focus. Its visual system combines a monumental macro-industrial opening with a quiet, warm-paper reading environment.

## Sources consulted

- `docs/superpowers/specs/2026-07-21-obsidian-publishing-and-blog-redesign-design.md` for approved information architecture, visual direction, and imagery restrictions.
- `docs/superpowers/plans/2026-07-21-site-editorial-redesign.md` for production interfaces, palette values, typography, content constraints, and the approved original hero path.
- `src/pages/index.astro` and `src/layouts/Base.astro` for the current site structure and existing navigation.
- `src/content/entries/滨化股份-g5-级电子级氢氟酸真业务小体量与第二曲线验证.md` for the only published research content represented in the mockup.
- `public/images/brand/commodities-macro-hero.png` for the approved, original generated commodities panorama (SHA-256 `ea97f6ebe3fa7503171aa0974f0e6a0832a6c05fa7d742fd47b93956e38a3c64`).

The user's temporary reference image was not consulted as production imagery, copied, traced, or included.

## Index

- `SKILL.md` — portable usage contract.
- `tokens/colors_and_type.css` — canonical raw and semantic tokens.
- `brand/style-notes.md` — layout, type, color, imagery, interaction, and responsive rules.
- `brand/voice-and-tone.md` — content hierarchy, language, and factual-writing rules.
- `../../mockups/deep-value-editorial/homepage.html` — high-fidelity homepage reference.

## Production interfaces

The stable CSS variables are:

```css
--color-ink;
--color-paper;
--color-copper;
--color-olive;
--font-editorial;
--font-data;
--step--1;
--step-0;
--step-1;
--step-2;
--step-3;
--step-4;
--step-5;
```

Components should consume semantic aliases where possible, while production layout files may expose the stable variables directly.

## Canonicality

This system is intentionally narrow. It establishes the publication's surfaces, typography, rules, motion, voice, and approved hero treatment. It does not invent a broad component library before production patterns exist. Extend it only from shipped UI and published content.
