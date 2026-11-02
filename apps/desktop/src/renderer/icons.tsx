import React from 'react';

type P = { className?: string };
/** Standard window-minimize minus, consistent with the app's line icons. */
export const MinimizeIcon = (p: P) => <S {...p}><path d="M5 12h14" /></S>;
export const FocusLayoutIcon = (p: P) => <S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M16 4v16M16 10h5M16 15h5" /><path d="m8 9 4 3-4 3z" /></S>;
const S = (props: { children: React.ReactNode } & P) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={props.className}
    width="20"
    height="20"
  >
    {props.children}
  </svg>
);

export const MoneyIcon = (p: P) => (
  <S {...p}><rect x="2" y="5" width="20" height="14" rx="2" /><circle cx="12" cy="12" r="3" /><path d="M6 9h.01M18 15h.01" /></S>
);
export const ChatIcon = (p: P) => (
  <S {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></S>
);
/** A speech bubble with a mark: Send feedback. */
export const FeedbackIcon = (p: P) => (
  <S {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /><path d="M12 7v4M12 14h.01" /></S>
);
export const FolderIcon = (p: P) => (
  <S {...p}><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></S>
);
export const ServerIcon = (p: P) => (
  <S {...p}><rect x="3" y="4" width="18" height="7" rx="2" /><rect x="3" y="13" width="18" height="7" rx="2" /><path d="M7 7.5h.01M7 16.5h.01" /></S>
);
export const PlugIcon = (p: P) => (
  <S {...p}><path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0zM12 16v6" /></S>
);
export const BrainIcon = (p: P) => (
  <S {...p}><path d="M12 5a3 3 0 0 0-6 .5A3 3 0 0 0 5 11a3 3 0 0 0 1 5 3 3 0 0 0 6 .5zM12 5a3 3 0 0 1 6 .5A3 3 0 0 1 19 11a3 3 0 0 1-1 5 3 3 0 0 1-6 .5z" /></S>
);
export const GearIcon = (p: P) => (
  <S {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></S>
);
export const SendIcon = (p: P) => (
  <S {...p}><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></S>
);
export const PlusIcon = (p: P) => (<S {...p}><path d="M12 5v14M5 12h14" /></S>);
export const SearchIcon = (p: P) => (<S {...p}><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></S>);
export const CalendarIcon = (p: P) => (<S {...p}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></S>);
export const ChevronUpIcon = (p: P) => (<S {...p}><path d="m6 15 6-6 6 6" /></S>);
export const ChevronDownIcon = (p: P) => (<S {...p}><path d="m6 9 6 6 6-6" /></S>);
export const TrashIcon = (p: P) => (<S {...p}><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /></S>);
export const ShieldIcon = (p: P) => (<S {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></S>);
/** A frame with its panel down the left side: show or hide a left side panel. */
export const PanelLeftIcon = (p: P) => (<S {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /></S>);
/** A curved two-headed arrow swinging between a frame's left side and its top: move a panel between them. */
export const PanelSwapIcon = (p: P) => (<S {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M7.5 16.5Q7.5 7.5 16.5 7.5" /><path d="M14 5.5l2.5 2-2.5 2M5.5 14l2 2.5 2-2.5" /></S>);
export const PanelIcon = (p: P) => (<S {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M15 3v18" /></S>);
export const PinIcon = (p: P) => (<S {...p}><path d="M12 17v5M9 3h6l-1 6 3 3H7l3-3z" /></S>);
export const FileIcon = (p: P) => (<S {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></S>);
export const GridIcon = (p: P) => (<S {...p}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></S>);
export const LayoutIcon = (p: P) => (<S {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M9 9v12" /></S>);
export const ExternalIcon = (p: P) => (<S {...p}><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></S>);
export const DownloadIcon = (p: P) => (<S {...p}><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 19h16" /></S>);
export const PencilIcon = (p: P) => (<S {...p}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></S>);
export const StarIcon = (p: P & { filled?: boolean }) => (<S {...p}><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z" fill={p.filled ? 'currentColor' : 'none'} /></S>);
export const DotsIcon = (p: P) => (<S {...p}><circle cx="5" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="19" cy="12" r="1.4" fill="currentColor" /></S>);
export const PinIcon2 = (p: P) => (<S {...p}><path d="M9 4h6l-1 5 3 2v2H7v-2l3-2-1-5zM12 13v7" /></S>);
export const CheckIcon = (p: P) => (<S {...p}><path d="M20 6 9 17l-5-5" /></S>);
export const SunIcon = (p: P) => (<S {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></S>);
/** A tilted instant photo: Nekko's own, not the stock picture glyph. */
export const PhotoIcon = (p: P) => (<S {...p}><g transform="rotate(-8 12 12)"><rect x="4.5" y="3" width="15" height="18" rx="2" /><rect x="7" y="5.5" width="10" height="9.5" rx="1" /><path d="m7 13.5 3.2-3 2.3 2 1.5-1.2 3 2.5" /><circle cx="14.2" cy="8.4" r="1" /></g></S>);
/** A prompt and cursor, no frame: a terminal. */
export const TerminalIcon = (p: P) => (<S {...p}><path d="m5 17 5-5-5-5M12 18h7" /></S>);
/** Changes: a plus over a minus in a square, the usual diff glyph. */
export const DiffIcon = (p: P) => (<S {...p}><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M12 7v6M9 10h6M9 16h6" /></S>);
/** More: three dots stacked, for an overflow menu. */
export const MoreVerticalIcon = (p: P) => (<S {...p}><circle cx="12" cy="5" r="1.4" fill="currentColor" /><circle cx="12" cy="12" r="1.4" fill="currentColor" /><circle cx="12" cy="19" r="1.4" fill="currentColor" /></S>);
export const SplitIcon = (p: P) => (<S {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" /></S>);
/** A drag handle: the two columns of dots every reorderable list uses. */
export const GripIcon = (p: P) => (<S {...p}><circle cx="9" cy="6" r="1.1" fill="currentColor" /><circle cx="15" cy="6" r="1.1" fill="currentColor" /><circle cx="9" cy="12" r="1.1" fill="currentColor" /><circle cx="15" cy="12" r="1.1" fill="currentColor" /><circle cx="9" cy="18" r="1.1" fill="currentColor" /><circle cx="15" cy="18" r="1.1" fill="currentColor" /></S>);
/** A git branch: a trunk, a fork off it, and a node on each. */
export const BranchIcon = (p: P) => (<S {...p}><circle cx="6" cy="6" r="2.4" /><circle cx="6" cy="18" r="2.4" /><circle cx="18" cy="8" r="2.4" /><path d="M6 8.4v7.2M18 10.4c0 3.2-2.4 4.6-5.4 5.2-1.8.4-3.2.9-4.2 1.8" /></S>);
/** A git worktree: a second checkout folder hanging off the same repository. */
export const WorktreeIcon = (p: P) => (<S {...p}><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h4.5A1.5 1.5 0 0 1 17 8.5V10" /><rect x="7" y="12" width="14" height="8" rx="1.5" /><path d="M5 5v9.5a1.5 1.5 0 0 0 1.5 1.5H7" /></S>);
export const CloseIcon = (p: P) => (<S {...p}><path d="M18 6 6 18M6 6l12 12" /></S>);
export const ArchiveIcon = (p: P) => (<S {...p}><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></S>);
export const BinocularsIcon = (p: P) => (<S {...p}><circle cx="6.5" cy="15.5" r="3.5" /><circle cx="17.5" cy="15.5" r="3.5" /><path d="M10 15.5h4M3 15.5 5 6.5a1.5 1.5 0 0 1 3 0v5.5M21 15.5l-2-9a1.5 1.5 0 0 0-3 0v5.5M8 9h8" /></S>);
/** A price tag: a task in a project-management tool. */
export const TagIcon = (p: P) => (<S {...p}><path d="M3 9V5a2 2 0 0 1 2-2h4l12 12-6 6L3 9z" /><circle cx="7.5" cy="7.5" r="1.2" /></S>);
export const RobotIcon = (p: P) => (<S {...p}><rect x="4" y="8" width="16" height="11" rx="2" /><path d="M12 8V4M9 13h.01M15 13h.01M2 13h2M20 13h2" /></S>);
export const WandIcon = (p: P) => (<S {...p}><path d="m15 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1zM6 13l1.5 3L11 17.5 7.5 19 6 22l-1.5-3L1 17.5 4.5 16zM20 14l.8 1.6L22.5 16l-1.7.4L20 18l-.8-1.6L17.5 16l1.7-.4z" /></S>);
/** A horseshoe magnet, poles down, in the theme's ink, with sparks off the tips: snap to grid. */
export const MagnetIcon = (p: P) => (
  <svg viewBox="0 0 24 24" fill="none" className={p.className} width="20" height="20" aria-hidden="true">
    <path d="M6 12.5V10a6 6 0 0 1 12 0v2.5" stroke="currentColor" strokeWidth="3.4" />
    <path d="M6 12.5v3.5M18 12.5v3.5" stroke="currentColor" strokeWidth="3.4" />
    <path d="M4.2 18.6 3 19.8M6 18.9v1.8M7.8 18.6l1.2 1.2M16.2 18.6 15 19.8M18 18.9v1.8M19.8 18.6l1.2 1.2" stroke="var(--magnet-spark, currentColor)" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
export const BoltIcon = (p: P) => (<S {...p}><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></S>);
export const WrenchIcon = (p: P) => (<S {...p}><path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.7L3 17.7A2 2 0 1 0 6.3 21l5.7-5.7a4.5 4.5 0 0 0 5.7-6L14.5 12l-2.5-2.5z" /></S>);
export const PlaneIcon = (p: P) => (<S {...p}><path d="M17.8 19.2 16 11l3.5-3.5a2.1 2.1 0 1 0-3-3L13 8 4.8 6.2a1 1 0 0 0-.9.3l-.5.5 6 4-3 3-2.6-.5-.8.8 3 2 2 3 .8-.8L8.3 16l3-3 4 6 .5-.5a1 1 0 0 0 .3-.9z" /></S>);
/** Incognito: the hat-and-sunglasses figure browsers use for private windows. */
export const IncognitoIcon = (p: P) => (<S {...p}><path d="M2 11h20" /><path d="M5 11l1.6-5.4A1.5 1.5 0 0 1 8.4 4.6l3.6 1.2 3.6-1.2a1.5 1.5 0 0 1 1.8 1L19 11" /><circle cx="7.5" cy="17" r="3" /><circle cx="16.5" cy="17" r="3" /><path d="M10.5 17a2.1 2.1 0 0 1 3 0" /></S>);
/** A globe: this agent may reach the internet. */
export const GlobeIcon = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></S>);
/** A globe struck through: this agent is blocked from the internet. */
export const GlobeOffIcon = (p: P) => (<S {...p}><path d="M5.6 5.6A9 9 0 0 0 18.4 18.4M20.3 15.6A9 9 0 0 0 8.4 3.7M3 12h9M15.8 12h5.2M12 3c1.3 1.4 2.3 2.9 2.9 4.6M8.2 12c0 3.4 1.3 6.4 3.8 9 .9-1 1.7-2 2.3-3.1" /><path d="M3 3l18 18" /></S>);
/** Angle brackets: code, as in code mode. */
export const CodeIcon = (p: P) => (<S {...p}><path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16" /></S>);
export const ListIcon = (p: P) => (<S {...p}><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></S>);
export const ToolStepIcon = (p: P) => (<S {...p}><path d="M12 3 3 8l9 5 9-5zM3 8v8l9 5 9-5V8" /></S>);
export const ThoughtIcon = (p: P) => (<S {...p}><path d="M12 4a5 5 0 0 0-4.9 4A4 4 0 0 0 8 16h8a4 4 0 0 0 1-7.9A5 5 0 0 0 12 4z" /><path d="M9 20h.01M6.5 22h.01" /></S>);
export const WarningIcon = (p: P) => (<S {...p}><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3zM12 9v4M12 17h.01" /></S>);
// Editor actions.
export const UndoIcon = (p: P) => (<S {...p}><path d="M3 8h9a5 5 0 0 1 0 10H7" /><path d="m7 4-4 4 4 4" /></S>);
export const RedoIcon = (p: P) => (<S {...p}><path d="M21 8h-9a5 5 0 0 0 0 10h5" /><path d="m17 4 4 4-4 4" /></S>);
export const CopyIcon = (p: P) => (<S {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H5a2 2 0 0 0-2 2v7.5A2.5 2.5 0 0 0 5.5 15" /></S>);
export const PasteIcon = (p: P) => (<S {...p}><path d="M9 4H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" /><rect x="9" y="2" width="6" height="4" rx="1" /></S>);
// Explorer disclosure chevron (rotated for the open state).
/** Line rocket, nose up, with a flame and speed streaks (see `.status-rocket`). */
export const RocketIcon = (p: P) => (
  <S {...p}>
    <path className="rocket-body" d="M12 2.5c2.6 2 3.8 5 3.8 8.6V16H8.2v-4.9c0-3.6 1.2-6.6 3.8-8.6z" />
    <circle className="rocket-body" cx="12" cy="9.5" r="1.6" />
    <path className="rocket-body" d="M8.2 12.5 5.8 15v2.2l2.4-1.2M15.8 12.5l2.4 2.5v2.2l-2.4-1.2" />
    <path className="rocket-flame" d="M10.6 18.2 12 21.5l1.4-3.3" />
    <path className="rocket-streak" d="M3.5 6.5v4M20.5 6.5v4M2.5 13v3M21.5 13v3" />
  </S>
);
/** A question mark in a ring: something is waiting on you. */
export const QuestionIcon = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.8M12 17h.01" /></S>);
/** "Zz": idle, asleep until you wake it. */
export const SleepIcon = (p: P) => (<S {...p}><path d="M4 9h6l-6 8h6M14 5h5l-5 6h5" /></S>);
/** Two arrows squeezing inward onto a line: a transcript being compacted. */
export const CompactIcon = (p: P) => (<S {...p}><path d="M12 3v6m0 0-3-3m3 3 3-3M12 21v-6m0 0-3 3m3-3 3 3M4 12h16" /></S>);
export const ChevronIcon = (p: P) => (<S {...p}><path d="m9 6 6 6-6 6" /></S>);

/** A target ring (two rings and a centre dot) for focusing one agent window. */
export const TargetIcon = (p: P) => <S {...p}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /></S>;
/** Configure: three vertical sliders, each knob at a different height. */
export const SlidersIcon = (p: P) => <S {...p}><path d="M6 4v4m0 4v8M12 4v10m0 4v2M18 4v1m0 4v11" /><circle cx="6" cy="10" r="2" /><circle cx="12" cy="16" r="2" /><circle cx="18" cy="7" r="2" /></S>;
export const ControlPanelIcon = (p: P) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M8 6v3m0 4v5m8-12v7m0 4v1M6 9h4m4 4h4" /><circle cx="8" cy="11" r="2" /><circle cx="16" cy="15" r="2" /></S>;

/* Mode panel glyphs: one per setting and per option, so the panel scans by shape. */
export const CloudIcon = (p: P) => (<S {...p}><path d="M7 18.5h10.5a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.6 9.1 4.7 4.7 0 0 0 7 18.5z" /></S>);
export const PhoneIcon = (p: P) => (<S {...p}><rect x="6.5" y="2.5" width="11" height="19" rx="2" /><path d="M11 18.5h2" /></S>);
export const ComputerIcon = (p: P) => (<S {...p}><rect x="3.5" y="4.5" width="17" height="12" rx="2" /><path d="M9 20.5h6M12 16.5v4" /></S>);
/** The ready burst's check, on a 16 box because its path is drawn on by dash length. */
export const ReadyCheckIcon = () => (
  <svg viewBox="0 0 16 16"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
/** A crescent with a small z: Do not disturb. */
export const MoonIcon = (p: P) => (
  <S {...p}><path d="M20 14.6A8.6 8.6 0 1 1 9.4 4a7 7 0 0 0 10.6 10.6z" /><path strokeWidth="1.5" d="M15.5 5.5h3l-3 3.5h3" /></S>
);
/** Two halves in balance: Balanced. */
export const YinYangIcon = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="9.2" />
    <path fill="currentColor" stroke="none" fillRule="evenodd" d="M12 2.8a9.2 9.2 0 0 1 0 18.4 4.6 4.6 0 0 1 0-9.2 4.6 4.6 0 0 0 0-9.2zM12 15.1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6z" />
    <circle cx="12" cy="7.4" r="1.3" fill="currentColor" stroke="none" />
  </S>
);
export const LaptopIcon = (p: P) => (<S {...p}><rect x="4" y="4.5" width="16" height="11" rx="1.5" /><path d="M2 19.5h20" /></S>);
export const CubeIcon = (p: P) => (<S {...p}><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7zM3.5 7 12 11.5 20.5 7M12 11.5v10" /></S>);
export const HandIcon = (p: P) => (<S {...p}><path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5M14 10.5V5.5a1.5 1.5 0 0 1 3 0V13c0 4.2-2.7 7.5-6.7 7.5-2.4 0-3.9-1.2-5-3L3.4 14.4a1.5 1.5 0 0 1 2.4-1.8L8 15" /></S>);
export const ShieldCheckIcon = (p: P) => (<S {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m8.8 12 2.2 2.2 4.2-4.4" /></S>);
export const RouteIcon = (p: P) => (<S {...p}><circle cx="5.5" cy="18.5" r="2" /><circle cx="18.5" cy="5.5" r="2" /><path d="M7.5 18.5h7a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6h7" /></S>);
export const GaugeIcon = (p: P) => (<S {...p}><path d="M3.5 17a8.5 8.5 0 1 1 17 0" /><path d="m12 17 4-5.5" /></S>);
export const CompassIcon = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></S>);
export const CapIcon = (p: P) => (<S {...p}><path d="M2 9 12 4.5 22 9l-10 4.5zM6 10.8v4.7c1.8 1.5 3.8 2.2 6 2.2s4.2-.7 6-2.2v-4.7M22 9v6" /></S>);
export const LockIcon = (p: P) => (<S {...p}><rect x="4.5" y="10.5" width="15" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></S>);
export const DialIcon = (p: P) => (<S {...p}><circle cx="12" cy="12" r="9" /><path d="m12 12 4.5-4.5" /></S>);
export const SparkleIcon = (p: P) => (<S {...p}><path d="M11 3c.6 4.6 2.2 6.8 6.5 7.5-4.3.7-5.9 2.9-6.5 7.5-.6-4.6-2.2-6.8-6.5-7.5C8.8 9.8 10.4 7.6 11 3z" /><path d="M19 15.5v5M16.5 18h5" /></S>);
export const DocTextIcon = (p: P) => (<S {...p}><path d="M14 2.5H6.5a1.5 1.5 0 0 0-1.5 1.5v16a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V7.5z" /><path d="M14 2.5v5h5M8.5 12h7M8.5 15.5h7M8.5 8.5h3" /></S>);
/** Four rising bars with the first `level` filled: reasoning effort at a glance. */
export const EffortBarsIcon = ({ level, className }: P & { level: number }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.4}>
    {[0, 1, 2, 3].map((i) => <rect key={i} x={3.5 + i * 4.6} y={16 - i * 3.6} width={3} height={4.5 + i * 3.6} rx={0.8} fill={i < level ? 'currentColor' : 'none'} />)}
  </svg>
);
