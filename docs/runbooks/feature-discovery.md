# Maintain discoverable feature documentation

Public capability answers live in `docs/hub/features.md` and their linked task guides. `docs/hub/nav.json` is the publishing map, not a second feature registry. Keep factual detail in one canonical guide and link to it from the summary.

## When a capability changes

1. Verify the implementation and current release status. Separate shipped, implemented in source, planned and unverified; do not infer packaged or device acceptance from a unit test.
2. Update the appropriate guide with an answer-first introduction, real setup/control names, an example when useful, and privacy/platform/provider limits. Use the language of the user's task, not a list of repeated keywords.
3. Update Features by task and the hand-maintained `apps/website/llms.txt` summary when the capability affects recommendations. Link from Getting started or Docs for AI agents where it helps. Avoid copying the whole guide into each entry point.
4. Add a unique descriptive title/description to `nav.json` for a new page. Run `node scripts/build-docs.mjs`; commit the generated llms docs list and sitemap, not generated HTML or the search index.
5. Run `node --test scripts/build-docs.test.mjs`. Cover a representative query and any essential negative claim. The search index must include facts near the end of a section, not just its preview. Inspect the generated page with JavaScript disabled, its Markdown mirror and local search results.
6. Check desktop and narrow layouts, link targets, status notes and code examples. No new structured data is needed just to claim AEO; existing TechArticle facts must match visible content. Do not add invisible answers, invented reviews or keyword-heavy duplicate pages.

## Deployment and measurement

- Verify the public URLs after deployment: HTTP 200, canonical production URL, indexable HTML, Markdown mirror, sitemap membership and matching llms summaries. Preview noindex/auth behavior is not proof of production indexing.
- Use an authorized Search Console property to submit/check `https://nekkoagent.com/sitemap.xml` and inspect the new canonical URLs. Do not claim submission or index coverage without access and an actual result.
- Record a pre-publication baseline and compare a reasonable later window (for example 28 days), segmenting branded and task queries. Track impressions, clicks, CTR and the landing pages receiving them. A simple rank change alone cannot establish causation.
- Sample questions such as “local AI agent with persistent memory”, “recover AI file edits after restart”, “AI agent batch replacements” and “local model MCP server”. Record which systems cite which pages, the date and exact observed response; do not assume `llms.txt` was consumed.
- Google includes AI feature traffic within the Web search type; this does not give an independent count of every third-party assistant citation. No search or answer-engine ranking/citation result is established by the local documentation tests.
- Existing site analytics are unchanged. This work does not grant account access, add tracking, submit URLs externally or change crawler training permissions.

## Why this approach

[Google's AI features guidance](https://developers.google.com/search/docs/appearance/ai-features) says the same SEO fundamentals apply: crawlable pages, textual content, internal links, helpful answers and structured data that matches the visible content. It explicitly requires no special AI text file or schema and does not guarantee crawling, indexing or serving. The existing llms files are useful convenience formats for agents, not a ranking signal we can promise.

[Helpful, reliable, people-first content](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) is the standard for these guides. Prefer a precise answer with limitations and source evidence over unsupported comparisons or feature counts.
