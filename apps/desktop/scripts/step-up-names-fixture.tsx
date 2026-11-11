// Settings → Security with a key and a named code app, for naming and renaming methods (#2556). Synthetic data only.
const NOW = Date.now();
(window as any).nekko = new Proxy({}, { get: () => () => Promise.resolve(null) });
import('@fontsource-variable/geist');
import('@fontsource-variable/geist-mono');
import('../src/renderer/styles.css');
Promise.all([import('react'), import('react-dom/client'), import('../src/renderer/components/security/SecuritySettings')]).then(
  ([React, { createRoot }, { SecuritySettingsView }]) => {
    const h = React.createElement;
    const noop = () => {};
    const status: any = {
      available: true,
      enabled: true,
      methods: [{ id: 'k1', name: 'Yubikey', kind: 'security-key', addedAt: NOW - 86_400_000, lastUsedAt: NOW - 86_400_000, cloned: false }],
      totp: { name: 'Microsoft Authenticator', addedAt: NOW - 600_000 },
      recoveryLeft: 10,
      minMethods: 2,
      coverMs: 300_000,
      covered: {},
    };
    createRoot(document.getElementById('root')!).render(
      h(
        'main',
        { style: { width: 680, padding: 24, background: 'var(--paper)', minHeight: '100vh' } },
        h(SecuritySettingsView, {
          status,
          codes: null,
          totp: null,
          pairedPhones: 0,
          webAuthnBlocked: null,
          passkeys: true,
          rpId: 'localhost',
          onAddKey: () => false,
          onTotpBegin: noop,
          onTotpConfirm: noop,
          onTotpCancel: noop,
          onCodesSaved: noop,
          onEnable: noop,
          onDisable: noop,
          onRemove: noop,
          onRename: () => false,
          onNewCodes: noop,
          onCopyCodes: noop,
        }),
      ),
    );
  },
);
