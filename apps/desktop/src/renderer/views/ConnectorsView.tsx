import React from 'react';
import { ConnectorGrid } from '../components/ConnectorGrid.js';
import { MessagingChannels } from '../components/MessagingChannels.js';
import { hasAppChrome } from '../chrome.js';

/**
 * The Connectors tab: a header plus the shared connector grid (also reused by
 * the onboarding integrations step in compact form), then the inbound
 * messaging channels (Telegram) that drive chats rather than fetch context.
 */
export function ConnectorsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        {!hasAppChrome && <h1 className="view-title">Connectors</h1>}
        <p className="mt-1 text-[13px] text-ink-faint">
          Pull issues, messages, and docs into context. Credentials are stored locally and validated on
          connect.
        </p>
        <div className="mt-6">
          <ConnectorGrid />
        </div>
        <h2 className="mt-10 text-lg font-semibold">Messaging channels</h2>
        <p className="mt-1 text-[13px] text-ink-faint">
          Drive a chat from a messaging app: each channel binds a conversation to one Nekko Agent session,
          and only allowlisted chat ids can reach it.
        </p>
        <div className="mt-4">
          <MessagingChannels />
        </div>
      </div>
    </div>
  );
}
