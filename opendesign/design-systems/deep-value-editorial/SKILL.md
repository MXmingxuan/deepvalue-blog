---
name: deep-value-editorial
description: Apply the canonical Deep Value Research editorial system to publication surfaces about investment, trading, commodities, AI, and research practice.
---

# Deep Value Editorial System

Use this system for Deep Value publication pages, article surfaces, research-log streams, and related brand artifacts.

## Required foundation

- Load `tokens/colors_and_type.css` before component styles.
- Use the required production interfaces: `--color-ink`, `--color-paper`, `--color-copper`, `--color-olive`, `--font-editorial`, `--font-data`, and `--step--1` through `--step-5`.
- Build with two dominant surfaces: charcoal context and warm-paper reading areas.
- Set Chinese headlines and long-form prose in `--font-editorial`; reserve `--font-data` for dates, codes, tickers, labels, and compact metadata.

## Composition rules

- Begin important landing pages with one cinematic macro image, then transition decisively into a ruled editorial grid.
- Prefer square fields, straight rules, asymmetrical columns, and visible publication structure.
- Keep radii at zero for editorial content and at most `--radius-control` for small interface controls.
- Use copper for selective links and moments of emphasis. Use olive for secondary metadata, never as a decorative wash.
- Use borders instead of floating card shadows. `--shadow-lift` is reserved for overlays that genuinely leave the page plane.

## Content rules

- State facts, observations, uncertainty, and verification conditions plainly.
- Never invent article titles, research entries, market prices, live statistics, or performance claims to fill a layout.
- Use explicit empty states when a collection contains no published work.
- Write Chinese headings in sentence case. Keep English labels short, uppercase, and functional.

## Imagery and motion

- Use original, compositionally distinct imagery of resources, industry, transport, power, infrastructure, geology, or archival cartography.
- Never ship, trace, crop, or use the user-provided temporary reference image as an image-generation input.
- The approved homepage hero for this iteration is `public/images/brand/commodities-macro-hero.avif`.
- Motion is restrained: one entrance sequence or one clear state transition, 140–700ms, with `prefers-reduced-motion` support.

Read `README.md`, `brand/style-notes.md`, and `brand/voice-and-tone.md` before extending the system.
