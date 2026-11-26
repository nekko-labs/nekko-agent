# Public site translations

The source of truth is the English HTML in `apps/website` and the Markdown and release notes rendered by `scripts/build-docs.mjs`. Each locale file maps a hash of an English text unit to its translation. The build keeps the markup, IDs, links, and code samples; if the English source changes before a translation is ready, that text falls back to English.

- Run `node scripts/site-languages/coverage.mjs --check` to check coverage before a multilingual release.
- On macOS with an SDK supporting the Translation framework, install the needed languages in System Settings. Run `node scripts/site-languages/refresh.mjs` or pass tags such as `ja es` to refresh a subset. The helper translates locally and saves progress in the catalog files. Do not run two writers for the same locale. No macOS service, credentials, or translation request is needed to build or browse the deployed website.
- To edit a translation, compute its key with `textKey` and `normalize` from `scripts/site-languages/catalog.mjs` using the English source string, then edit the locale JSON. The refresh helper preserves existing entries. Keep technical terms and `{placeholders}` intact.
- Review the first-run marketing copy, policy language and technical pages before publication. Check localized heading wraps, section links, the search dialog, and the hamburger on both desktop and phone.
