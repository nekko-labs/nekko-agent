import React from 'react';
import { ConnectorGrid, connectorGridClass } from '../components/ConnectorGrid.js';
import { ConfiguredMcpServers, HypergateConnector } from '../components/HypergateConnector.js';
import { MessagingChannels } from '../components/MessagingChannels.js';
import { Group } from '../components/primitives/index.js';
import { hasAppChrome } from '../chrome.js';
import { CONNECTORS_GUIDE, PageGuideButton, PageIntro, usePageIntro } from '../components/PageIntro.js';

/**
 * The Connectors tab: a header plus the shared connector grid in its groups
 * (also reused by the onboarding integrations step in compact form), then
 * Gateways (Hypergate), the MCP servers configured in Settings, and the inbound
 * messaging channels (Telegram) that drive chats rather than fetch context.
 */
export function ConnectorsView() {
  const intro = usePageIntro('connectors');
  return (
    <div className="h-full overflow-y-auto">
      {intro.show && <PageIntro guide={CONNECTORS_GUIDE} onClose={intro.close} />}
      <div className="@container mx-auto max-w-5xl px-4 pt-3 pb-8">
        {!hasAppChrome && <h1 className="view-title">Connectors</h1>}
        <div className="mt-1 flex items-start justify-between gap-3">
          <p className="text-xs text-ink-soft">
            Pull issues, messages, and docs into context. Credentials are stored locally and validated on
            connect.
          </p>
          <PageGuideButton name="Connectors" onClick={intro.open} />
        </div>
        <div className="mt-5">
          <ConnectorGrid>
            <Group title="Gateways" data-connector-group="gateways">
              <div className={connectorGridClass()}>
                <HypergateConnector />
              </div>
            </Group>
            <ConfiguredMcpServers />
            <Group title="Messaging channels" data-connector-group="messaging">
              <p className="text-xs text-ink-faint">
                Drive a chat from a messaging app: each channel binds a conversation to one Nekko Agent session,
                and only allowlisted chat ids can reach it.
              </p>
              <div className="mt-(--q-inline) grid grid-cols-1 gap-5 @3xl:grid-cols-2 @6xl:grid-cols-3">
                <MessagingChannels />
              </div>
            </Group>
          </ConnectorGrid>
        </div>
      </div>
    </div>
  );
}
