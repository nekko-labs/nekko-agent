import React, { useMemo } from 'react';
import './chatTags.css';
import { useStore } from '../store.js';
import { ChatGroupDot } from './ChatGroupDot.js';
import { chatGroupColorValue, chatGroupLabel, type ChatGroup } from '../views/chatGroups.js';
import { breadcrumbParts, visibleChatTags } from '../views/chatTags.js';
import { chatGroupTagCatalog, useChatGroupPrefs } from '../views/useChatGroupPrefs.js';

const Sep = () => <span aria-hidden="true" className="shrink-0 text-sm text-ink-faint opacity-40">/</span>;

/** The group part of the crumb: a named group is its name in the group's colour; an unnamed group is its dot alone, named for screen readers. */
export function CrumbGroup({ group }: { group: ChatGroup }) {
  const color = chatGroupColorValue(group.color);
  if (group.name) return <span className="min-w-0 truncate" dir="auto" style={{ color }}>{group.name}</span>;
  return <ChatGroupDot color={color} name={chatGroupLabel(group)} label={chatGroupLabel(group)} />;
}

/** The tags part of the crumb: `#a #b`, a few of them, "+N" for the rest. */
export function CrumbTags({ tags }: { tags: ReadonlyArray<string> }) {
  const { shown, more } = visibleChatTags(tags, 3);
  return (
    <>
      <span className="min-w-0 truncate" dir="auto">{shown.map((t) => `#${t}`).join(' ')}</span>
      {more > 0 && <span className="shrink-0 text-ink-faint">+{more}</span>}
    </>
  );
}

/**
 * The chat window's title strip, from the icon on: `group / #tags / title`.
 * A part with no value is left out with its separator, and with neither group
 * nor tags the strip is just the title (`titleNode`, drawn by the caller so it
 * keeps its own look). The group and tags only say what they are: hovering
 * names them, and they are not buttons. A chat's group and tags change from the
 * Agents panel's right-click menu, or a new chat's button by the model.
 */
export function ChatBreadcrumb({ sessionId, titleNode }: { sessionId: string; titleNode: React.ReactNode }) {
  const session = useStore((s) => s.sessions.find((x) => x.id === sessionId));
  const prefs = useChatGroupPrefs();
  const sessions = useMemo(() => (session ? [session] : []), [session]);
  const catalog = useMemo(() => chatGroupTagCatalog(sessions, prefs.defined, prefs.storedTags), [sessions, prefs.defined, prefs.storedTags]);
  const group = catalog.index.resolve(session?.chatGroup);
  const parts = breadcrumbParts({ group, tags: session?.tags, title: '' }).filter((p) => p.kind !== 'title');
  if (parts.length === 0) return <>{titleNode}</>;
  const label = (key: string, text: string, className: string, content: React.ReactNode) => (
    <span key={key} className={`flex min-w-0 items-center gap-1 ${className}`} title={text} aria-label={text} data-chat-crumb={key}>
      {content}
    </span>
  );
  return (
    <>
      <span className="flex min-w-0 shrink items-center gap-1" data-chat-crumb-parts>
        {parts.map((p) => (
          <React.Fragment key={p.kind}>
            {p.kind === 'group' && label('group', `Group: ${chatGroupLabel(p.group)}`, 'max-w-[9rem] shrink-0 text-xs text-ink-soft', <CrumbGroup group={p.group} />)}
            {p.kind === 'tags' && label('tags', `Tags: ${p.tags.map((t) => `#${t}`).join(' ')}`, 'max-w-[9rem] text-2xs text-ink-faint', <CrumbTags tags={p.tags} />)}
            <Sep />
          </React.Fragment>
        ))}
      </span>
      {titleNode}
    </>
  );
}
