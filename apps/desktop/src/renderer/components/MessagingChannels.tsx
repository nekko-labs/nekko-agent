import React, { useEffect, useState } from 'react';
import type { MessagingStatus, TelegramMessagingConfig } from '@nekko-agent/shared';
import { Badge } from './primitives/index.js';
import { TelegramIcon } from '../connectorIcons.js';

/**
 * Inbound messaging channels (T151): let a messaging app drive a chat, so the
 * agent can be reached like a person rather than only through the app window.
 * Unlike the connector rows above, these are listeners: connecting one starts
 * a poll loop in the host, and the allowlist of chat ids is the whole
 * authorization boundary (off + empty list = refuses everyone).
 */
export function MessagingChannels() {
  const [cfg, setCfg] = useState<TelegramMessagingConfig>({});
  const [status, setStatus] = useState<MessagingStatus['telegram']>();
  const [token, setToken] = useState('');
  const [chatIds, setChatIds] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    const [settings, st] = await Promise.all([window.nekko.getSettings(), window.nekko.getMessagingStatus()]);
    const tg = settings.messaging?.telegram ?? {};
    setCfg(tg);
    setToken(tg.botToken ?? '');
    setChatIds((tg.allowedChatIds ?? []).join(', '));
    setStatus(st.telegram);
  };
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Partial<TelegramMessagingConfig>) => {
    setSaving(true);
    setError('');
    try {
      const next = { ...cfg, ...patch };
      const allowedChatIds = chatIds.split(',').map((s) => s.trim()).filter(Boolean);
      // settings merge is shallow: re-read so a sibling adapter's block survives.
      const cur = (await window.nekko.getSettings()).messaging ?? {};
      await window.nekko.updateSettings({
        messaging: { ...cur, telegram: { ...next, botToken: token.trim() || undefined, allowedChatIds } },
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const running = !!status?.running;
  return (
    <div className="min-w-0 py-1" data-channel="telegram">
      <div className="flex items-start justify-between gap-2 py-2">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center">
            <TelegramIcon size={20} />
          </span>
          <div className="flex min-w-0 flex-col" style={{ gap: 'var(--q-tight)' }}>
            <h3 className="text-sm font-medium">Telegram</h3>
            <p className="text-xs text-ink-faint">
              Message your agent from Telegram; it replies in the same chat. Long-polls, so no public URL needed.
            </p>
          </div>
        </div>
        {running ? (
          <Badge tone="success" variant="solid">
            {status?.botUsername ? `@${status.botUsername}` : 'listening'}
          </Badge>
        ) : (
          cfg.enabled && <Badge tone="neutral">starting…</Badge>
        )}
      </div>

      <div className="space-y-2" style={{ paddingLeft: 48 }}>
        <input
          className="input py-1 text-xs"
          type="password"
          placeholder="Bot token from @BotFather"
          aria-label="Telegram bot token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={saving}
        />
        <input
          className="input py-1 text-xs"
          placeholder="Allowed chat ids, comma separated (message the bot, then check getUpdates)"
          aria-label="Allowed Telegram chat ids"
          value={chatIds}
          onChange={(e) => setChatIds(e.target.value)}
          disabled={saving}
        />
        <div className="flex flex-row-reverse items-center gap-2">
          <button
            className="btn btn-primary py-1 text-xs"
            disabled={saving || !token.trim() || !chatIds.trim()}
            onClick={() => void save({ enabled: true })}
          >
            {saving ? 'Saving…' : cfg.enabled ? 'Save' : 'Enable'}
          </button>
          {cfg.enabled && (
            <button className="btn btn-ghost py-1 text-xs" disabled={saving} onClick={() => void save({ enabled: false })}>
              Disable
            </button>
          )}
        </div>
        <p className="text-2xs text-ink-faint">
          Only the listed chat ids can reach the agent, everything else is refused. Approvals and the agent's
          questions arrive as buttons; replies stream into one edited message.
        </p>
        {status?.lastError && (
          <p className="text-2xs" style={{ color: 'var(--danger-text)' }}>
            {status.lastError}
          </p>
        )}
        {status && status.boundChats > 0 && <p className="text-2xs text-ink-faint">{status.boundChats} chat{status.boundChats === 1 ? '' : 's'} bound to sessions.</p>}
        {error && (
          <p className="text-2xs" style={{ color: 'var(--danger-text)' }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
