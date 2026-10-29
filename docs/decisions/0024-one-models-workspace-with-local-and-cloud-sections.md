# One Models workspace with local and cloud sections

- Status: accepted
- Scope: [Models and providers](../../spec/models/models-providers.md)

## Context

Separate Model Providers and Model Server rail destinations make model setup harder to find and spend screen space explaining the distinction. The requested design combines them, with left subnavigation and compact provider additions beside configured providers.

## Decision

Use one Models rail entry with Local model server and Cloud providers sections. Keep the existing `models` and `modelserver` view identifiers so command, onboarding and monitor links still open the right destination. Place third-party local connections with the built-in server, not among cloud credentials. Keep existing setup flows, including first-provider onboarding. Show five popular cloud setup shortcuts and a full chooser behind an overflow button; shortcuts do not save or authenticate by themselves.

## Consequences

The navigation and layout change, not the provider configuration schema or engine lifecycle. Local connections may require scrolling below the engine's controls. At phone widths subnavigation moves above the content. Native mobile apps keep their existing settings surfaces.
