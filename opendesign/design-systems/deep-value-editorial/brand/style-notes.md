# Visual style notes

## Character

Deep Value should feel monumental, restrained, and exacting. The macro/commodities mood comes from showing how resources move through extraction, industry, transport, power, and technology. Historical depth is welcome; costume nostalgia and trading-terminal decoration are not.

## Surfaces and color

- `#0b0c0b` is the charcoal shell, hero field, and inverse reading context.
- `#d8cfbd` is the warm-paper reading surface. It should occupy most content-heavy pages.
- `#a46743` is oxidized copper. Use it for chosen links, issue markers, and one focal detail at a time.
- `#777b68` is muted olive. Use it for dates, taxonomy, captions, and low-emphasis metadata.
- Derive hairline borders from the current surface with `color-mix`; borders should structure the page without becoming a grid illustration.
- Avoid gradients as decoration. Dark overlays on photography may use simple linear fades solely to protect legibility.

## Typography

Chinese titles and long-form reading use the editorial serif stack in `--font-editorial`. Data, dates, tags, English eyebrows, ticker symbols, and navigation indices use `--font-data`. Do not use display type so large that Chinese line breaks become theatrical or difficult to scan.

Headlines are compact and slightly tight. Body copy uses generous line height and a measure of roughly 36–48 Chinese characters. Metadata is small but not faint; letter spacing belongs mainly to short Latin labels.

## Layout and geometry

- Use a full-width dark visual field for the homepage opening and transition directly into warm paper.
- Compose content with ruled columns, issue labels, metadata rails, and uneven editorial proportions rather than uniform cards.
- Editorial blocks are square. Use `0` radius by default and no more than `2px` for compact controls.
- Keep the reading order obvious when the desktop grid collapses. Mobile targets must be at least `44px` high.
- Use generous outer whitespace around essays and denser rhythm for indices, metadata, and chronological streams.
- Borders carry hierarchy. Shadows are exceptional and never the default card treatment.

## Imagery

Suitable imagery includes ports, bulk carriers, mines, storage, energy infrastructure, geological formations, archival textures, and restrained cartography. It should connect physical systems rather than celebrate abstract finance.

Use only original or licensed production assets. The user-provided temporary reference is a mood reference only: never include it, trace it, crop it, or submit it as an image-generation reference. For the current homepage, use only `public/images/brand/commodities-macro-hero.avif`, encoded from the approved original panorama.

Images are concentrated in hero and topic-cover contexts. Article bodies remain visually quiet unless a source image materially supports the research.

## Motion and states

Motion communicates entry or state, not spectacle. Prefer one 500–700ms hero reveal and 140–280ms underline, color, or offset transitions. Hover states may shift a rule or color by a few pixels; cards do not bounce or float. Respect `prefers-reduced-motion: reduce` and remove nonessential transforms.

Focus states use a clearly visible copper outline with a small offset. Active navigation is expressed by a rule or text color rather than a pill.
