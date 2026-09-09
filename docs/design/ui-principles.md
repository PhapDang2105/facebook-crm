# UI Design Principles

## Direction

The CRM interface should feel minimal, spacious, comfortable, and modern.

## Rules

- Use one clear title per page or content block.
- Do not add subtitles, helper notes, status copy, or decorative labels unless required for a user decision.
- Prioritize data, actions, and navigation over explanatory content.
- Use the available viewport; avoid arbitrary maximum widths that create unused space.
- Use responsive grids that expand and reflow based on available width.
- Maintain comfortable spacing without producing large empty regions.
- Keep the color palette restrained and reserve the primary color for navigation state and important actions.
- Prefer simple borders and subtle surfaces over heavy shadows or decoration.
- Keep interaction labels short and written in Vietnamese.
- Use large, readable typography throughout the application. Body text and interactive controls should normally be at least 16px; secondary text should not be smaller than 14px; table headers should not be smaller than 13px. Reserve 12px or smaller text only for exceptional metadata that is not required to complete a task.
- Optimize type sizes for comfortable reading on large desktop monitors. Do not shrink text merely to fit more rows; use spacing, responsive layouts, or horizontal scrolling instead.
- Maintain a clear type hierarchy: page title 28–32px, section title 18–20px, primary body/table content 16px, secondary content 14px.
- Do not place a large page-title header above the primary content. Navigation already identifies the active screen, so opening or switching a tab should reveal its useful content immediately.

## Internal dashboard reference

Use the internal Giot Nang management dashboard as a visual reference for hierarchy: a dark global header, a light compact navigation rail, pale blue-gray workspace surfaces, white rounded metric cards, strong numeric hierarchy, restrained blue/green/orange accents, and full-width data layouts. Adapt these patterns to CRM tasks instead of copying screens literally.

The cloned `quan-ly-doanh-nghiep` reference also provides reusable implementation patterns: centralized design tokens, consistent spacing scales, responsive navigation collapse, accessible focus states, tabular number alignment, horizontal overflow handling for dense tables, and team-specific accent colors. Keep these ideas independent from its application code and business logic.
