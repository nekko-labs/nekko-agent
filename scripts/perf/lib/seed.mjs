/**
 * A scratch data directory for the Local Web UI: one provider (the mock), and
 * a set of seeded chats. Never the user's real data dir.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcript } from './content.mjs';

/** Title and newest-message marker for seeded chat `i`. */
export const chatTitle = (i) => `Perf chat ${String(i).padStart(2, '0')}`;
export const lastMarker = (i) => `[perf-${String(i).padStart(2, '0')}-newest]`;

export function seedDataDir({ mockPort, chats }) {
  const dir = mkdtempSync(join(tmpdir(), 'nekko-perf-data-'));
  writeFileSync(
    join(dir, 'settings.json'),
    JSON.stringify({
      theme: 'dark',
      defaultProviderId: 'mock',
      defaultModelId: 'mock-1',
      providers: [
        { id: 'mock', kind: 'openai-compat', label: 'Perf mock', baseUrl: `http://127.0.0.1:${mockPort}/v1`, enabled: true },
      ],
      workspaces: [],
      onboarding: { completedAt: Date.UTC(2026, 0, 1) },
    }),
  );
  const sessionsDir = join(dir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const now = Date.now();
  const ids = [];
  chats.forEach((count, i) => {
    const id = `s_perf_${String(i).padStart(2, '0')}`;
    ids.push(id);
    const messages = transcript({
      seed: 1000 + i,
      count,
      marker: (turn, newest) => (newest ? lastMarker(i) : `[perf-${i}-${turn}]`),
    });
    const session = {
      id,
      title: chatTitle(i),
      titleAuto: false,
      providerId: 'mock',
      modelId: 'mock-1',
      mode: 'yolo',
      messages,
      createdAt: now - 86_400_000,
      // Chat 0 is the newest, so it lands first everywhere lists sort by recency.
      updatedAt: now - i * 60_000,
    };
    writeFileSync(join(sessionsDir, `${id}.json`), JSON.stringify(session, null, 2));
  });
  return { dir, ids };
}
