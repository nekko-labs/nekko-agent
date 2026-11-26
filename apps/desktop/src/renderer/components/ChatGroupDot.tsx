import React from 'react';

/** A small dot in a chat group's colour, named by the group for hover and screen readers. `label` replaces "Group: name", for an unnamed group. */
export function ChatGroupDot({ color, name, label }: { color: string; name: string; label?: string }) {
  return <span role="img" data-chat-group-dot aria-label={label ?? `Group: ${name}`} title={label ?? `Group: ${name}`} className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}
