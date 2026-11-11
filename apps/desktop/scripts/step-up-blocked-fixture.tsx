// Settings → Security with one method registered, so Turn on is blocked (#2392, #2393). Synthetic data only.
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
      enabled: false,
      methods: [{ id: 'k1', name: 'YubiKey 5C', kind: 'security-key', addedAt: NOW - 3_600_000, lastUsedAt: NOW - 600_000, cloned: false }],
      totp: null,
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
