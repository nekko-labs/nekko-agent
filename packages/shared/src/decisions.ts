/**
 * Decision models: typed questions about a state, answered with calibrated
 * probabilities in one pass. The request and response are TypeSafe Jev's
 * (`/v1/systemone`), which Laya's local runtime speaks too.
 */

export type DecisionProvider = 'local' | 'typesafe';
export type DecisionPrecision = 'fp16' | 'fp32' | 'int8';

export interface DecisionQuestion {
  /** `choice`: one of `criteria`. `score`: a level on the ordered `criteria`. `noul`: probability true. */
  type: 'choice' | 'score' | 'noul';
  instructions: string;
  criteria?: Record<string, string> | string[];
}

export interface DecisionRequest {
  model?: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, DecisionQuestion>;
}

export interface DecisionAnswer {
  type: DecisionQuestion['type'];
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
  /** For `score`: level index to its label. */
  legend?: Record<string, string>;
  /** A question that could not be answered; the others still are. */
  error?: string;
}

export interface DecisionResponse {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: Record<string, number>;
  provider: DecisionProvider;
  latencyMs: number;
}

export interface DecisionCatalogEntry {
  id: string;
  name: string;
  publisher: string;
  license: string;
  /** Where the files come from: the release they are pinned to and the checkpoint they were exported from. */
  source?: string;
  /** Why it cannot be downloaded in the app yet, when it cannot. */
  unavailable?: string;
  description: string;
  variants: Array<DecisionFile & { precision: DecisionPrecision; recommended?: boolean }>;
  /** Tokenizer and config every variant needs. */
  shared: DecisionFile[];
}

/** One file of a catalog model: saved as `file`, fetched as `asset`, checked against `bytes` and `sha256`. */
export interface DecisionFile {
  file: string;
  bytes: number;
  /** The release asset's name, when it differs from `file` (assets of one release share a folder). */
  asset?: string;
  sha256?: string;
}

export interface InstalledDecisionModel {
  id: string;
  name: string;
  dir: string;
  precisions: DecisionPrecision[];
  sizeBytes: number;
  catalogId?: string;
  /** A folder the user pointed at: removing it forgets the folder, never deletes it. */
  external?: boolean;
}

export interface DecisionStatus {
  local: {
    /** False outside the desktop app, where there is no engine daemon to run it. */
    available: boolean;
    loaded: boolean;
    model?: string;
    dir?: string;
    /** The execution provider actually in use: directml, coreml, cuda or cpu. */
    ep?: string;
    precision?: DecisionPrecision;
    loadMs?: number;
    reason?: string;
  };
  typesafe: { configured: boolean };
}
