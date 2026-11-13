/**
 * Types for the Design board: a Figma-style canvas holding live snapshots of an
 * app's real pages plus AI-generated design concepts. Concepts are created two
 * ways, both first-class: draw a rough sketch (iPad/iPhone friendly) that gets
 * turned into a working HTML prototype, or describe the design in a prompt and
 * watch it pop up. Concepts can then be refined iteratively.
 */

/** A persistent note pinned to a design page. */
export interface DesignNote {
  id: string;
  text: string;
  createdAt: number;
}

/**
 * One card on the design board. Two kinds:
 * - 'live' (default when absent): a snapshot of a running page, rendered as a
 *   scaled read-only preview of `url`.
 * - 'concept': a design; `html` is the self-contained prototype (rendered via
 *   iframe srcdoc) and `file` is its file in the workspace's `nekko-designs/`
 *   folder, which agents and users keep working on as code. The board follows
 *   that folder: an edit to the file shows on the card, and an HTML file
 *   saved there becomes a card.
 */
export interface DesignPage {
  id: string;
  /** Human label (e.g. "Home", "Settings", "Pricing concept"). */
  label: string;
  /** Live pages: URL the page renders at (e.g. http://localhost:3000/about). Empty for concepts. */
  url: string;
  kind?: 'live' | 'concept';
  /** Concepts: the generated self-contained HTML prototype. */
  html?: string;
  /** Bounded previous editable snapshots, newest last. */
  revisions?: { id: string; html: string; createdAt: number }[];
  /** Concepts: the prompt that produced (or last refined) the html. */
  prompt?: string;
  /** Concepts: where this came from. `file`: found in the project's `nekko-designs/` folder, saved there by an agent or a person. */
  origin?: 'prompt' | 'sketch' | 'file';
  /** Concepts: absolute path of the prototype file written into the workspace. */
  file?: string;
  /** Persistent notes the user pinned to this page. */
  notes: DesignNote[];
  createdAt: number;
  updatedAt: number;
}

/** The design board for a single workspace. */
export interface DesignBoard {
  workspaceId: string;
  pages: DesignPage[];
}

/** Input for generating (or refining) a design concept. */
export interface GenerateDesignInput {
  /** What to design; when refining an existing concept, the change to apply. */
  prompt: string;
  /** A hand-drawn sketch (PNG data URL) to turn into the prototype. */
  sketchDataUrl?: string;
  /** Refine this existing concept page instead of creating a new one. */
  pageId?: string;
  /** Label for a new concept card (defaults to a trim of the prompt). */
  label?: string;
}
