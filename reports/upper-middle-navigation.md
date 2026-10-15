# Upper-middle navigation rail

## Intent
Move the desktop/tablet left navigation destinations above their previous vertically centered position. Preserve mobile bottom navigation, destination order, hit targets, hover labels and keyboard access.

## Guidance and trade-offs
- [Microsoft NavigationView](https://learn.microsoft.com/en-us/windows/apps/develop/ui/controls/navigationview): compact left navigation reveals labels over content and supports consistent, adaptive access to many categories. It does not mandate a vertical fraction.
- [Material navigation rail](https://m3.material.io/components/navigation-rail/guidelines) is a relevant component reference; the fetched page is JavaScript-only, so no detailed positioning claim is attributed to it.
- Upper-third positioning is a Nekko visual choice, not a published universal standard. Exact fixed viewport offsets risk clipping as the number of visible destinations or window height changes.

## Implementation
Distribute unused vertical space 1:3 above and below the destination group. For group height G and usable height H, its center is H/4 + G/4 (plus container padding), between one-quarter and one-half of the rail depending on group height. This moves the buttons upward without reserving an arbitrary blank block. When the group exceeds available height, the spacers collapse and the group scrolls; button hit targets do not shrink.

## Verification
A network-blocked isolated Electron fixture renders source-derived rail markup with production CSS, eleven synthetic destinations, dark/light themes and 600/1000/1400 pixel content heights. Geometry and renderer captures are saved under `.shots/upper-rail`. Native capture must be inspected separately before claiming desktop-window visual evidence. Icons in the fixture are synthetic placeholders, not proof of production icon rendering.
