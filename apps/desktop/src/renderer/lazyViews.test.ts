import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const here = (f: string) => new URL(f, import.meta.url);

describe('code splitting of the non-default views', () => {
  it('keeps every split view out of the entry imports', () => {
    const app = readFileSync(here('./App.tsx'), 'utf8');
    for (const v of ['Artifacts', 'Skills', 'Training', 'Workflows', 'DesignBoard', 'ModelsWorkspace', 'Connectors', 'Memory', 'Settings', 'Onboarding']) {
      expect(app, v).not.toMatch(new RegExp(`from '\\./views/${v}\\w*\\.js'`));
    }
    expect(app).toMatch(/from '\.\/lazyViews\.js'/);
  });

  it('loads qrcode on demand', () => {
    for (const f of ['./components/RemoteAccess.tsx', './components/security/SecuritySettings.tsx', './components/cloud/RecoveryKeyDialog.tsx']) {
      const src = readFileSync(here(f), 'utf8');
      expect(src, f).not.toMatch(/import QRCode from 'qrcode'/);
      expect(src, f).toMatch(/import\('qrcode'\)/);
    }
  });
});
