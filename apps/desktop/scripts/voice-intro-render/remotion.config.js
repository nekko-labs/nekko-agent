// Settings for scripts/render-voice-intro.mjs. The component imports its siblings with a ".js" suffix
// (the app's bundler resolves that to ".ts"/".tsx"), so Remotion's webpack needs the same alias.
import { Config } from '@remotion/cli/config';

Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: { ...config.resolve, extensionAlias: { '.js': ['.tsx', '.ts', '.js'] } },
}));
