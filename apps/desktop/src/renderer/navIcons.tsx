import React from 'react';

/**
 * Colorful, playful duotone icons for the left navigation rail. Unlike the
 * monochrome `icons.tsx` set (used inside buttons that inherit text color),
 * these carry their own vivid palette so the rail reads as fun and lively.
 * Hover / click / active motion is driven by CSS in styles.css (`.nav-item svg`).
 *
 * Each icon is a 24×24 glyph rendered at 22px. Colors are mid-saturation so they
 * stay legible on both the light (#fbfbfd) and dark (#0c0c11) rail backgrounds.
 */

type P = { className?: string };

const Svg = ({ children, className }: { children: React.ReactNode } & P) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" className={className}>
    {children}
  </svg>
);

/** Chat — a friendly violet speech bubble with colored dots. */
export const ChatColorIcon = (p: P) => (
  <Svg {...p}>
    <path
      d="M4.5 6.2A2.5 2.5 0 0 1 7 3.7h10a2.5 2.5 0 0 1 2.5 2.5v6.4a2.5 2.5 0 0 1-2.5 2.5h-5.7L6.6 20v-3.4A2.5 2.5 0 0 1 4.5 14z"
      fill="#7c6cff"
    />
    <circle cx="9" cy="9.4" r="1.15" fill="#ffffff" />
    <circle cx="12" cy="9.4" r="1.15" fill="#c4b5fd" />
    <circle cx="15" cy="9.4" r="1.15" fill="#22d3ee" />
  </Svg>
);

/** Skills — a magic wand with a star tip and sparkles. */
export const SkillsColorIcon = (p: P) => (
  <Svg {...p}>
    <path d="M6 18.5 14.5 10" stroke="#f59e0b" strokeWidth="2.7" strokeLinecap="round" />
    <path d="M17.4 3.2l1.15 2.45 2.55.32-1.9 1.78.52 2.53-2.32-1.26-2.32 1.26.52-2.53-1.9-1.78 2.55-.32z" fill="#fbbf24" />
    <path d="M6 5.4l.62 1.5L8.1 7.5l-1.48.6L6 9.6l-.62-1.5L3.9 7.5l1.48-.6z" fill="#ec4899" />
    <circle cx="19" cy="15.5" r="1.1" fill="#f472b6" />
  </Svg>
);

/** Design — a colorful bento layout / palette. */
export const DesignColorIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="8.2" height="8.2" rx="2.2" fill="#f43f5e" />
    <rect x="12.8" y="3" width="8.2" height="5" rx="2.2" fill="#8b5cf6" />
    <rect x="12.8" y="9.6" width="8.2" height="11.4" rx="2.2" fill="#22d3ee" />
    <rect x="3" y="12.8" width="8.2" height="8.2" rx="2.2" fill="#fb923c" />
  </Svg>
);

/** Artifacts: a stack of produced pages, a document in front of a diagram card. */
export const ArtifactsColorIcon = (p: P) => (
  <Svg {...p}>
    <rect x="8.2" y="2.8" width="12" height="14.6" rx="2.2" fill="#38bdf8" opacity="0.55" />
    <path d="M11.6 7.4h5.2M11.6 10.4h3.6" stroke="#e0f2fe" strokeWidth="1.3" strokeLinecap="round" />
    <rect x="3.8" y="6.6" width="12" height="14.6" rx="2.2" fill="#0ea5e9" />
    <path d="M6.8 11h6M6.8 14h6M6.8 17h3.6" stroke="#e0f2fe" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="17.6" cy="18.4" r="2.6" fill="#fbbf24" />
  </Svg>
);

/** Models — a purple CPU / chip with pins. */
export const ModelsColorIcon = (p: P) => (
  <Svg {...p}>
    <path
      d="M9 2.6v2.2M12 2.6v2.2M15 2.6v2.2M9 19.2v2.2M12 19.2v2.2M15 19.2v2.2M2.6 9h2.2M2.6 12h2.2M2.6 15h2.2M19.2 9h2.2M19.2 12h2.2M19.2 15h2.2"
      stroke="#a78bfa"
      strokeWidth="1.7"
      strokeLinecap="round"
    />
    <rect x="5.5" y="5.5" width="13" height="13" rx="3" fill="#8b5cf6" />
    <rect x="9" y="9" width="6" height="6" rx="1.4" fill="#ddd6fe" />
  </Svg>
);

/**
 * Model Server — a stack of racked units with a live indicator.
 *
 * Deliberately a machine rather than another chip: Model Providers is where the
 * models come *from*, and this is the box on this desk that runs them.
 */
export const ModelServerColorIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3.4" y="4" width="17.2" height="5.4" rx="1.8" fill="#8b5cf6" />
    <rect x="3.4" y="11.4" width="17.2" height="5.4" rx="1.8" fill="#7c3aed" opacity="0.85" />
    <circle cx="6.6" cy="6.7" r="1.05" fill="#4ade80" />
    <circle cx="6.6" cy="14.1" r="1.05" fill="#ddd6fe" />
    <path d="M10 6.7h7M10 14.1h7" stroke="#ddd6fe" strokeWidth="1.3" strokeLinecap="round" opacity="0.8" />
    <path d="M8 19.6h8" stroke="#a78bfa" strokeWidth="1.7" strokeLinecap="round" />
  </Svg>
);

/** Connectors — a green plug. */
export const ConnectorsColorIcon = (p: P) => (
  <Svg {...p}>
    <path d="M9 2.8v4.6M15 2.8v4.6" stroke="#15803d" strokeWidth="2" strokeLinecap="round" />
    <path d="M6.4 7.4h11.2v3.1a5.6 5.6 0 0 1-11.2 0z" fill="#22c55e" />
    <path d="M12 15.8v5.4" stroke="#15803d" strokeWidth="2" strokeLinecap="round" />
  </Svg>
);

/** Memory — a two-tone pink brain. */
export const MemoryColorIcon = (p: P) => (
  <Svg {...p}>
    <path d="M11.4 5.4a3.3 3.3 0 0 0-6.2-1.1 3 3 0 0 0-1.3 5.2 3 3 0 0 0 .9 4.9 3 3 0 0 0 6.6 1z" fill="#ec4899" />
    <path d="M12.6 5.4a3.3 3.3 0 0 1 6.2-1.1 3 3 0 0 1 1.3 5.2 3 3 0 0 1-.9 4.9 3 3 0 0 1-6.6 1z" fill="#f472b6" />
  </Svg>
);

/** Settings — a cog with an accent hub. */
export const SettingsColorIcon = (p: P) => (
  <Svg {...p}>
    {[0, 45, 90, 135].map((a) => (
      <rect key={a} x="10.7" y="2.4" width="2.6" height="19.2" rx="1.3" fill="#64748b" transform={`rotate(${a} 12 12)`} />
    ))}
    <circle cx="12" cy="12" r="6.6" fill="#64748b" />
    <circle cx="12" cy="12" r="3" fill="#a5b4fc" />
  </Svg>
);

/** Training — a barbell with colored plates (the model gym). */
export const TrainingColorIcon = (p: P) => (
  <Svg {...p}>
    <rect x="4" y="10.8" width="16" height="2.4" rx="1.2" fill="#94a3b8" />
    <rect x="3" y="7" width="3" height="10" rx="1.4" fill="#22d3ee" />
    <rect x="18" y="7" width="3" height="10" rx="1.4" fill="#22d3ee" />
    <rect x="6.4" y="5.4" width="3" height="13.2" rx="1.4" fill="#6d5efc" />
    <rect x="14.6" y="5.4" width="3" height="13.2" rx="1.4" fill="#6d5efc" />
    <circle cx="12" cy="4.2" r="1.2" fill="#fbbf24" />
  </Svg>
);

/** Workflows — a node graph: steps, a branch, and a dashed loop back. */
export const WorkflowsColorIcon = (p: P) => (
  <Svg {...p}>
    {/* A three-node pipeline with a branch and a loop back, the shape of the
        thing itself: run a step, and route where it goes next. */}
    <path d="M8.6 7.4h3.2" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M14.4 8.9v4.6a1.6 1.6 0 0 1-1.6 1.6H9.4" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    <path d="M6.2 9.2v6.4a1.8 1.8 0 0 0 1.8 1.8h1.2" stroke="#fb923c" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2.4 2.4" fill="none" />
    <rect x="3" y="4.6" width="5.8" height="5.6" rx="1.7" fill="#a5b4fc" />
    <rect x="12" y="4.6" width="8.4" height="5.6" rx="1.7" fill="#6366f1" />
    <rect x="6.2" y="14" width="8.4" height="5.6" rx="1.7" fill="#34d399" />
    <circle cx="17.8" cy="16.8" r="2.5" fill="#fbbf24" />
  </Svg>
);
