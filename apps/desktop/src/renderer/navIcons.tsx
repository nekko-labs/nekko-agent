import React from 'react';

/**
 * Colorful, playful duotone icons for the left navigation rail. Unlike the
 * monochrome `icons.tsx` set (used inside buttons that inherit text color),
 * these carry their own vivid palette so the rail reads as fun and lively.
 * Hover / click / active motion is driven by CSS in styles.css (`.nav-item svg`).
 *
 * Each icon uses its native 16×16 or 24×24 grid, rendered at 22px. Colors are mid-saturation so they
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

/** Models: Gentleface brain-gear (0.3.0, MIT), recolored for the rail.
 * Source: https://gentleface.com/icons/brain-gear.json (solid-round).
 * Brain and gear retain the upstream geometry, including the gear's cut-out hub.
 */
export const ModelsColorIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" width="22" height="22" className={className} data-gentleface-icon="brain-gear">
    <path fill="#8b5cf6" d="M6 0.172L6 4L5 4C4.724 4 4.488 4.098 4.293 4.293C4.098 4.488 4 4.724 4 5L4 6.5C4 6.776 4.224 7 4.5 7C4.776 7 5 6.776 5 6.5L5 5L6 5L6 10L4.5 10C4.224 10 4 10.224 4 10.5C4 10.776 4.224 11 4.5 11L6 11L6 13.598C5.804 13.712 5.596 13.802 5.376 13.869C5.064 13.964 4.745 14.008 4.419 13.999C4.109 13.991 3.808 13.936 3.515 13.834C3.223 13.732 2.952 13.589 2.704 13.403C2.443 13.208 2.219 12.976 2.033 12.708C1.848 12.439 1.709 12.148 1.619 11.835C1.567 11.658 1.533 11.48 1.515 11.299C1.217 11.172 0.951 10.99 0.717 10.753C0.393 10.423 0.177 10.033 0.069 9.583C-0.039 9.133-0.023 8.687 0.116 8.246C0.143 8.161 0.174 8.079 0.208 8L2.5 8C2.776 8 3 7.776 3 7.5C3 7.224 2.776 7 2.5 7L0.206 7C0.143 6.854 0.094 6.699 0.058 6.537C-0.059 6.006-0.007 5.491 0.212 4.992C0.432 4.494 0.777 4.109 1.248 3.836C1.505 3.688 1.771 3.588 2.048 3.538C2.034 3.456 2.022 3.374 2.014 3.29C1.981 2.95 2.005 2.615 2.087 2.283C2.168 1.952 2.302 1.644 2.489 1.358C2.666 1.088 2.88 0.853 3.132 0.652C3.385 0.451 3.662 0.295 3.965 0.184C4.285 0.066 4.616 0.005 4.957 0C5.299-0.005 5.631 0.047 5.954 0.156C5.97 0.161 5.985 0.166 6 0.172ZM7 0.172C7.015 0.166 7.03 0.161 7.046 0.156C7.369 0.047 7.701-0.005 8.043 0C8.384 0.005 8.715 0.066 9.035 0.184C9.338 0.295 9.615 0.451 9.868 0.652C10.12 0.853 10.334 1.088 10.511 1.358C10.698 1.644 10.832 1.952 10.913 2.283C10.995 2.615 11.019 2.95 10.986 3.29C10.978 3.374 10.966 3.456 10.952 3.538C11.229 3.588 11.495 3.688 11.752 3.836C12.223 4.109 12.568 4.494 12.788 4.992C12.985 5.44 13.047 5.902 12.972 6.377C12.822 6.218 12.624 6.112 12.408 6.075C11.803 5.974 11.197 5.974 10.592 6.075C10.158 6.148 9.823 6.495 9.766 6.932L9.63 7.963C9.542 8.009 9.456 8.059 9.372 8.112L9 7.958L9 7.5C9 7.224 8.776 7 8.5 7C8.224 7 8 7.224 8 7.5L8 7.638C7.711 7.646 7.44 7.779 7.256 8.002C7.166 8.111 7.081 8.223 7 8.337L7 4L8.5 4C8.776 4 9 3.776 9 3.5C9 3.224 8.776 3 8.5 3L7 3L7 0.172Z" />
    <path fill="#a78bfa" d="M15.573 9.587C15.663 9.779 15.607 10.007 15.44 10.135L14.44 10.902C14.521 11.301 14.521 11.699 14.44 12.098L15.44 12.865C15.607 12.993 15.663 13.221 15.573 13.413C15.465 13.643 15.339 13.863 15.193 14.071C15.072 14.245 14.847 14.31 14.652 14.23L13.488 13.747C13.183 14.017 12.838 14.216 12.452 14.345L12.288 15.594C12.26 15.804 12.091 15.966 11.88 15.984C11.627 16.006 11.373 16.006 11.12 15.984C10.909 15.966 10.74 15.804 10.712 15.594L10.548 14.345C10.162 14.216 9.817 14.017 9.512 13.747L8.348 14.23C8.153 14.31 7.928 14.245 7.807 14.071C7.661 13.863 7.535 13.643 7.427 13.413C7.337 13.221 7.393 12.993 7.56 12.865L8.56 12.098C8.479 11.699 8.479 11.301 8.56 10.902L7.56 10.135C7.393 10.007 7.337 9.779 7.427 9.587C7.535 9.357 7.661 9.137 7.807 8.929C7.928 8.755 8.153 8.69 8.348 8.77L9.512 9.253C9.817 8.983 10.162 8.784 10.548 8.655L10.712 7.406C10.74 7.196 10.909 7.034 11.12 7.016C11.373 6.994 11.627 6.994 11.88 7.016C12.091 7.034 12.26 7.196 12.288 7.406L12.452 8.655C12.838 8.784 13.183 8.983 13.488 9.253L14.652 8.77C14.847 8.69 15.072 8.755 15.193 8.929C15.339 9.137 15.465 9.357 15.573 9.587ZM11.5 13C12.328 13 13 12.328 13 11.5C13 10.672 12.328 10 11.5 10C10.672 10 10 10.672 10 11.5C10 12.328 10.672 13 11.5 13Z" />
  </svg>
);

/**
 * Model Server — a stack of racked units with a live indicator.
 *
 * Deliberately a machine rather than a brain: Models is where the
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

/** Scheduled Tasks — Gentleface workflow-clock (0.3.0, MIT), recolored for the rail.
 * Source: https://gentleface.com/icons/workflow-clock.json (solid-round).
 * The two subpaths retain the upstream geometry; only their fills differ.
 */
export const WorkflowsColorIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" width="22" height="22" className={className} data-gentleface-icon="workflow-clock">
    <path fill="#6366f1" d="M6 7L5 7L5 10C5 10.209 5.06 10.4 5.179 10.571C5.299 10.743 5.457 10.865 5.653 10.938C5.785 10.987 5.88 11.073 5.937 11.197C5.993 11.32 5.997 11.448 5.949 11.58C5.901 11.71 5.814 11.803 5.689 11.861C5.563 11.919 5.436 11.924 5.306 11.876C4.914 11.731 4.598 11.486 4.359 11.143C4.12 10.799 4 10.418 4 10L4 7L3 7C2.724 7 2.488 6.902 2.293 6.707C2.098 6.512 2 6.276 2 6L2 3C2 2.724 2.098 2.488 2.293 2.293C2.488 2.098 2.724 2 3 2L6 2C6.276 2 6.512 2.098 6.707 2.293C6.902 2.488 7 2.724 7 3L7 6C7 6.276 6.902 6.512 6.707 6.707C6.512 6.902 6.276 7 6 7Z" />
    <path fill="#fbbf24" d="M13.156 7.316C13.734 7.545 14.243 7.879 14.682 8.318C15.121 8.757 15.455 9.266 15.684 9.844C15.895 10.376 16 10.928 16 11.5C16 12.072 15.895 12.624 15.684 13.156C15.455 13.734 15.121 14.243 14.682 14.682C14.243 15.121 13.734 15.455 13.156 15.684C12.624 15.895 12.072 16 11.5 16C10.928 16 10.376 15.895 9.844 15.684C9.266 15.455 8.757 15.121 8.318 14.682C7.879 14.243 7.545 13.734 7.316 13.156C7.105 12.624 7 12.072 7 11.5C7 10.928 7.105 10.376 7.316 9.844C7.545 9.266 7.879 8.757 8.318 8.318C8.757 7.879 9.266 7.545 9.844 7.316C10.376 7.105 10.928 7 11.5 7C12.072 7 12.624 7.105 13.156 7.316ZM12 8.5C12 8.224 11.776 8 11.5 8C11.224 8 11 8.224 11 8.5L11 11.5C11 11.776 11.224 12 11.5 12L13.5 12C13.776 12 14 11.776 14 11.5C14 11.224 13.776 11 13.5 11L12 11L12 8.5Z" />
  </svg>
);
