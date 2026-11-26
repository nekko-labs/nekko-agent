---
title: Public website languages
area: brand
---

# Public website languages

Status: in development ([#3462](https://github.com/nekko-labs/nekko-agent/issues/3462)).

Visitors can read the Nekko Agent public website in English, Japanese, Spanish, Korean, Simplified Chinese, Traditional Chinese, Russian, French, Italian, or German. The homepage, downloads, pricing, beta signup, privacy, status, design system, docs hub and What's New are in scope. The signed-in Nekko Cloud console, external destinations, downloadable media, command examples, and product interfaces shown in screenshots or videos are not translated by this feature. English is the source for policy and technical documentation. Do not treat localized text as independently reviewed legal or technical advice.

- The hamburger contains a Language picker on desktop and phones. It shows language names in their own language and an Automatic option. A manual choice is saved on that browser, can be cleared with Automatic, and takes the visitor to the equivalent page without losing the query or section anchor.
- An explicitly localized link opens in its own language. On an unprefixed entry, a saved choice wins; otherwise use the first supported language from the browser's ordered preferences. If those do not match, use a coarse country hint when available; English is the last fallback. Chinese script is honored first, then browser region (Traditional in Taiwan, Hong Kong and Macau, Simplified elsewhere).
- The location hint uses the hosting platform's country field, only when browser language negotiation fails. The site does not prompt for location, use GPS, call a third-party geo-IP or translation service from the browser, or store the country. The preference lives in first-party browser storage and is not added to analytics.
- Localized pages are readable without JavaScript. Keep links, anchors, install commands, product names and version identifiers stable. Publish translations at the same site origin and keep the original English URLs. Text not yet available in the selected language falls back to English, including upstream incidents and externally supplied contributor data.

Acceptance: exercise all supported locales across all public routes, browser preference order, unavailable country hint, manual override and reset, docs search and anchors, unchanged console behavior, and keyboard operation on desktop and phone. Check locale text for visible overflow. Initial offline translations are machine translations; language-by-language editorial and legal review is not implied.
