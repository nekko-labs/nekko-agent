// Settings for scripts/render-windows-install-help.mjs. The component imports its siblings with a ".js" suffix
// (the app's bundler resolves that to ".ts"/".tsx"), so Remotion's webpack needs the same alias.
import { Config } from '@remotion/cli/config';

Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: { ...config.resolve, extensionAlias: { '.js': ['.tsx', '.ts', '.js'] } },
}));

// The captured website (capture-site.mjs) lives beside these scripts. Paths resolve from
// apps/desktop, where render-windows-install-help.mjs runs Remotion.
Config.setPublicDir('./scripts/windows-install-help/public');
