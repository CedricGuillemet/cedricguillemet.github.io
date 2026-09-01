# Instructions for generating the New Features presentation

Create or update the presentation in `babylon/newfeatures26/html/` from the ideas in `babylon/newfeatures26/features.md`.

## Goal

Produce a polished, persuasive dark-theme HTML presentation for Babylon.js and Babylon Lite feature explorations. The deck should feel like a product vision presentation rather than a document or a marketing website.

## Content rules

- Make one full-viewport page per feature. Do not combine separate source-list items.
- Preserve the intent, uncertainty, and scope from `features.md`. Label research ideas as exploration rather than presenting them as committed roadmap work.
- Re-read `features.md` on every refresh and incorporate additions to existing ideas, including any newly supplied demos or requested media.
- Give every feature a short headline, a concise explanation, a tangible prototype/demo proposal, and the expected value.
- Treat each `output:` line as the required deliverable for the preceding idea. Show it prominently and consistently on that feature page; do not paraphrase away implementation-specific terms such as CLI, NGE, Inspector, runtime, or Frame Graph.
- Follow every source link before writing. Use its title, description, visual media, and technical claims accurately.
- Correct malformed source URLs when the intended page is unambiguous, but do not invent sources or quantitative claims.
- Attribute third-party media visibly and link to the original source. Prefer embedding publisher-hosted media over copying it into the repository.
- Use original HTML/CSS/SVG illustrations for features without supplied media. Do not use generic stock imagery.
- Keep copy short enough to present aloud. Avoid dense paragraphs and unsupported claims.

## Visual direction

- Dark, high-contrast theme with a restrained accent color unique to each feature.
- Editorial typography, large headlines, generous whitespace, fine grid lines, and compact monospace metadata.
- Each page needs one dominant visual: embedded video, source image, technical diagram, editor mockup, or animated CSS illustration.
- Keep a consistent fixed header, slide counter, navigation rail, and presentation hint.
- Design for 16:9 projection first, then adapt cleanly to tablet and mobile widths.
- Honor `prefers-reduced-motion`.

## Interaction and implementation

- Use plain HTML, CSS, and JavaScript with no build step and no framework dependency.
- Keep files split into `index.html`, `styles.css`, and `script.js`.
- Support mouse/trackpad scrolling, touch scrolling, arrow keys, Page Up/Down, Home/End, direct anchor links, and fullscreen mode.
- Use CSS scroll snapping so exactly one feature page is framed at a time.
- Keep navigation state, slide number, and URL anchors synchronized with the visible page.
- Use semantic sections, descriptive alternative text, labeled controls, keyboard focus states, and privacy-enhanced YouTube embeds.
- Lazy-load media below the first page where possible. Videos must be muted when autoplaying.
- Do not require a local server for basic viewing; opening `html/index.html` should work. Network access may still be required for attributed third-party embeds.

## Quality checks

Before finishing:

1. Confirm the number of feature pages matches the interpreted source list.
2. Open the deck at desktop and mobile widths and check that no text or controls are clipped.
3. Test all navigation methods and fullscreen mode.
4. Verify every external media URL and source link.
5. Confirm every third-party visual has visible attribution.
6. Check the browser console for errors.
