# 0115. A chat's page card opens on a click anywhere

Date: 2026-11-23. Status: accepted. Issue: #3212. Changes the chat card half of #3104, which made the card always interactive on the reasoning of [0094](0094-library-tiles-show-the-file-and-a-design-is-always-interactive.md); Library's canvas stays as 0094 says.

## Context

Since #3104 a page a reply links to runs in its chat card and takes clicks, typing and scrolling like the page itself, with **Open in chat** (or **Open ↗**) and, for a design, **Open in Library** in the footer. Philip: "let's update the designs to have it open clicking anywhere. Change the button 'open in chat' to just be 'open' with an icon and to the right side." A click on the picture went into a 200-pixel, shrunken page instead of opening it.

## Decision

- **A click anywhere on the card opens the page** beside the chat (the file pane). The page still plays in the card, served as before, but takes no clicks or focus.
- **Open**, with Gentleface's arrow-up-right icon, is the footer's rightmost button; a design's **Open in Library** sits to its left. **Open in chat** and **Open ↗** are gone.

## Alternatives not taken

- **Keep the page interactive and open only from the footer.** What #3104 did; the card read as dead to a click on its picture.
- **Open on a click, but pass scrolling into the page.** A card that opens on a click but scrolls inside is two behaviors in one small box; the file pane and Library are where a page is used.

## Consequences

- To try a page's buttons or forms, open it. The file pane and Library run it at full size with **Load from internet** and, in the pane, **Edit text**.
- Keyboard users reach the page through **Open** (the card itself is not a button, since its footer holds buttons).
