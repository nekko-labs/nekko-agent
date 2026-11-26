import React from 'react';

/**
 * Colorful, playful duotone icons for the left navigation rail. Unlike the
 * monochrome `icons.tsx` set (used inside buttons that inherit text color),
 * these carry their own vivid palette so the rail reads as fun and lively.
 * Hover / click / active motion is driven by CSS in styles.css (`.nav-item svg`).
 *
 * Each icon uses its native 16×16 or 24×24 grid, rendered at 22px. Colors are mid-saturation so they
 * stay legible on both the light (#fbfbfd) and dark (#0b0c14) rail backgrounds.
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

/** Library: Gentleface grid (0.6.0, MIT), recolored in the existing blue/gold palette.
 * Source: https://gentleface.com/icons/grid.json (solid-round).
 * Each square is an unchanged upstream subpath on the native 16px grid.
 */
export const ArtifactsColorIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" width="22" height="22" className={className} data-gentleface-icon="grid">
    <path fill="#0ea5e9" d="M7 6C7 6.276 6.902 6.512 6.707 6.707C6.512 6.902 6.276 7 6 7L3 7C2.724 7 2.488 6.902 2.293 6.707C2.098 6.512 2 6.276 2 6L2 3C2 2.724 2.098 2.488 2.293 2.293C2.488 2.098 2.724 2 3 2L6 2C6.276 2 6.512 2.098 6.707 2.293C6.902 2.488 7 2.724 7 3L7 6Z" />
    <path fill="#38bdf8" d="M13 2C13.276 2 13.512 2.098 13.707 2.293C13.902 2.488 14 2.724 14 3L14 6C14 6.276 13.902 6.512 13.707 6.707C13.512 6.902 13.276 7 13 7L10 7C9.724 7 9.488 6.902 9.293 6.707C9.098 6.512 9 6.276 9 6L9 3C9 2.724 9.098 2.488 9.293 2.293C9.488 2.098 9.724 2 10 2L13 2Z" />
    <path fill="#38bdf8" d="M7 13C7 13.276 6.902 13.512 6.707 13.707C6.512 13.902 6.276 14 6 14L3 14C2.724 14 2.488 13.902 2.293 13.707C2.098 13.512 2 13.276 2 13L2 10C2 9.724 2.098 9.488 2.293 9.293C2.488 9.098 2.724 9 3 9L6 9C6.276 9 6.512 9.098 6.707 9.293C6.902 9.488 7 9.724 7 10L7 13Z" />
    <path fill="#fbbf24" d="M13 9C13.276 9 13.512 9.098 13.707 9.293C13.902 9.488 14 9.724 14 10L14 13C14 13.276 13.902 13.512 13.707 13.707C13.512 13.902 13.276 14 13 14L10 14C9.724 14 9.488 13.902 9.293 13.707C9.098 13.512 9 13.276 9 13L9 10C9 9.724 9.098 9.488 9.293 9.293C9.488 9.098 9.724 9 10 9L13 9Z" />
  </svg>
);

/** Models: Gentleface brain-circuit (0.6.0, MIT), in the rail's existing violet.
 * Source: https://gentleface.com/icons/brain-circuit.json (solid-round).
 * Preserve the upstream silhouette, including the three circuit terminals.
 */
export const ModelsColorIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" width="22" height="22" className={className} data-gentleface-icon="brain-circuit">
    <path transform="rotate(90 8 8)" fill="#8b5cf6" d="M8 3L11.086 3C11.192 2.7 11.374 2.459 11.634 2.275C11.893 2.092 12.182 2 12.5 2C12.914 2 13.268 2.146 13.561 2.439C13.854 2.732 14 3.086 14 3.5C14 3.914 13.854 4.268 13.561 4.561C13.268 4.854 12.914 5 12.5 5C12.182 5 11.893 4.908 11.634 4.725C11.374 4.541 11.192 4.3 11.086 4L8 4L8 5L6 5C5.724 5 5.488 5.098 5.293 5.293C5.098 5.488 5 5.724 5 6L5 7.5C5 7.776 5.224 8 5.5 8C5.776 8 6 7.776 6 7.5L6 6L8 6L8 8L12.086 8C12.192 7.7 12.374 7.459 12.634 7.275C12.893 7.092 13.182 7 13.5 7C13.914 7 14.268 7.146 14.561 7.439C14.854 7.732 15 8.086 15 8.5C15 8.914 14.854 9.268 14.561 9.561C14.268 9.854 13.914 10 13.5 10C13.182 10 12.893 9.908 12.634 9.725C12.374 9.541 12.192 9.3 12.086 9L8 9L8 11L5.5 11C5.224 11 5 11.224 5 11.5C5 11.776 5.224 12 5.5 12L11.086 12C11.192 11.7 11.374 11.459 11.634 11.275C11.893 11.092 12.182 11 12.5 11C12.914 11 13.268 11.146 13.561 11.439C13.854 11.732 14 12.086 14 12.5C14 12.914 13.854 13.268 13.561 13.561C13.268 13.854 12.914 14 12.5 14C12.182 14 11.893 13.908 11.634 13.725C11.374 13.541 11.192 13.3 11.086 13L8 13L8 13.5C8 13.611 7.967 13.711 7.9 13.8C7.714 14.048 7.495 14.262 7.243 14.442C6.977 14.631 6.688 14.774 6.376 14.869C6.064 14.964 5.745 15.008 5.419 14.999C5.109 14.991 4.808 14.936 4.515 14.834C4.223 14.732 3.952 14.589 3.704 14.403C3.443 14.208 3.219 13.976 3.033 13.708C2.848 13.439 2.709 13.148 2.619 12.835C2.567 12.658 2.533 12.48 2.515 12.299C2.217 12.172 1.951 11.99 1.717 11.753C1.393 11.423 1.177 11.033 1.069 10.583C0.961 10.133 0.977 9.687 1.116 9.246C1.143 9.161 1.174 9.079 1.208 9L3.5 9C3.776 9 4 8.776 4 8.5C4 8.224 3.776 8 3.5 8L1.206 8C1.143 7.854 1.094 7.699 1.058 7.537C0.941 7.006 0.993 6.491 1.212 5.992C1.432 5.494 1.777 5.109 2.248 4.836C2.505 4.688 2.771 4.588 3.048 4.538C3.034 4.456 3.022 4.374 3.014 4.29C2.981 3.95 3.005 3.615 3.087 3.283C3.168 2.952 3.302 2.644 3.489 2.358C3.666 2.088 3.88 1.853 4.132 1.652C4.385 1.451 4.662 1.295 4.965 1.184C5.285 1.066 5.616 1.005 5.957 1C6.299 0.995 6.631 1.047 6.954 1.156C7.26 1.258 7.542 1.407 7.8 1.6C7.933 1.7 8 1.833 8 2L8 3Z" />
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

/** Settings: Gentleface's solid cog, with an accent hub. */
export const SettingsColorIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" width="22" height="22" className={className} data-gentleface-icon="settings">
    <path fill="#64748b" d="M8 1C8.276 1 8.512 1.098 8.707 1.293C8.902 1.488 9 1.724 9 2L9 3.102C9.563 3.257 10.075 3.515 10.536 3.875L11.723 3.084C11.834 3.009 11.955 2.983 12.083 3.004C12.211 3.026 12.316 3.09 12.398 3.197C12.896 3.851 13.257 4.573 13.481 5.364C13.511 5.469 13.507 5.573 13.47 5.673C13.433 5.774 13.369 5.855 13.277 5.916L12.061 6.727C12.152 7.242 12.152 7.758 12.061 8.273L13.277 9.084C13.369 9.145 13.433 9.226 13.47 9.327C13.507 9.427 13.511 9.531 13.481 9.636C13.257 10.427 12.896 11.149 12.398 11.803C12.316 11.91 12.211 11.974 12.083 11.996C11.955 12.017 11.834 11.991 11.723 11.916L10.536 11.125C10.075 11.485 9.563 11.743 9 11.898L9 13C9 13.276 8.902 13.512 8.707 13.707C8.512 13.902 8.276 14 8 14L7 14C6.724 14 6.488 13.902 6.293 13.707C6.098 13.512 6 13.276 6 13L6 11.898C5.437 11.743 4.925 11.485 4.464 11.125L3.277 11.916C3.166 11.991 3.045 12.017 2.917 11.996C2.789 11.974 2.684 11.91 2.602 11.803C2.104 11.149 1.743 10.427 1.519 9.636C1.489 9.531 1.493 9.427 1.53 9.327C1.567 9.226 1.631 9.145 1.723 9.084L2.939 8.273C2.848 7.758 2.848 7.242 2.939 6.727L1.723 5.916C1.631 5.855 1.567 5.774 1.53 5.673C1.493 5.573 1.489 5.469 1.519 5.364C1.743 4.573 2.104 3.851 2.602 3.197C2.684 3.09 2.789 3.026 2.917 3.004C3.045 2.983 3.166 3.009 3.277 3.084L4.464 3.875C4.925 3.515 5.437 3.257 6 3.102L6 2C6 1.724 6.098 1.488 6.293 1.293C6.488 1.098 6.724 1 7 1L8 1ZM7.5 5C7.182 5 6.875 5.059 6.58 5.176C6.259 5.303 5.976 5.488 5.732 5.732C5.488 5.976 5.303 6.259 5.176 6.58C5.059 6.875 5 7.182 5 7.5C5 7.818 5.059 8.125 5.176 8.42C5.303 8.741 5.488 9.024 5.732 9.268C5.976 9.512 6.259 9.697 6.58 9.824C6.875 9.941 7.182 10 7.5 10C7.818 10 8.125 9.941 8.42 9.824C8.741 9.697 9.024 9.512 9.268 9.268C9.512 9.024 9.697 8.741 9.824 8.42C9.941 8.125 10 7.818 10 7.5C10 7.182 9.941 6.875 9.824 6.58C9.697 6.259 9.512 5.976 9.268 5.732C9.024 5.488 8.741 5.303 8.42 5.176C8.125 5.059 7.818 5 7.5 5Z" />
    <circle cx="7.5" cy="7.5" r="2.5" fill="#a5b4fc" />
  </svg>
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

/** Automations: Gentleface bolt (0.6.0, MIT), in the rail's gold. The same glyph
 * marks Automations in the Monitors dock, so both say "this runs by itself".
 * Source: https://gentleface.com/icons/bolt.json (solid-round).
 */
export const AutomationsColorIcon = ({ className }: P) => (
  <svg viewBox="0 0 16 16" width="22" height="22" className={className} data-gentleface-icon="bolt">
    <path fill="#fbbf24" d="M9 6L11.5 6C11.641 6 11.759 6.048 11.856 6.144C11.952 6.241 12 6.359 12 6.5C12 6.596 11.975 6.684 11.924 6.765L6.924 14.765C6.849 14.885 6.746 14.96 6.613 14.99C6.481 15.021 6.355 14.999 6.235 14.924C6.161 14.878 6.104 14.818 6.062 14.743C6.021 14.668 6 14.587 6 14.5L6 10L3.5 10C3.359 10 3.241 9.952 3.144 9.856C3.048 9.759 3 9.641 3 9.5C3 9.404 3.025 9.316 3.076 9.235L8.076 1.235C8.149 1.118 8.253 1.044 8.388 1.013C8.522 0.982 8.648 1.003 8.765 1.076C8.839 1.122 8.896 1.182 8.938 1.257C8.979 1.332 9 1.413 9 1.5L9 6Z" />
  </svg>
);
