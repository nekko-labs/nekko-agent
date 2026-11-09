// The brand plum, everywhere the app shows its own colours rather than the theme's
// (spec/brand/colour-palette.md): the iPhone's launch screen, opening animation and
// pixel mascot, Android's opening splash, and the desktop's pixel mascot. The green
// brand of before the plum palette came back once on the iPhone; this keeps it out.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

// The retired green brand: ground, tile end, cream line, sage mark (hex, and Swift's 0-255 forms).
const legacy = [
  /(?:#|0x)(?:FF)?(?:101714|263d2d|f2f1e9|a7c8ac)\b/i,
  /0x10\s*\/\s*255,\s*green:\s*0x17/i,
  /\b16\s*\/\s*255,\s*green:\s*23\s*\/\s*255/,
  /\b242\s*\/\s*255,\s*green:\s*241\s*\/\s*255/,
  /\b167\s*\/\s*255,\s*green:\s*200\s*\/\s*255/,
  /0xA7\s*\/\s*255,\s*green:\s*0xC8/i,
  /red="0\.062745" green="0\.090196"/,
  // The retired lavender basic accent, last on the Live Activity card.
  /0x8B\s*\/\s*255,\s*green:\s*0x7D/i,
];

function files(dir, exts) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    const path = join(dir, name);
    if (statSync(join(root, path)).isDirectory()) out.push(...files(path, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(path);
  }
  return out;
}

test('the iPhone launch screen is plain brand plum, under a name iOS has not cached', () => {
  const name = read('apps/ios/Info.plist').match(/<key>UILaunchStoryboardName<\/key><string>([^<]+)<\/string>/)?.[1];
  assert.ok(name, 'Info.plist names a launch storyboard');
  const path = `apps/ios/App/${name}.storyboard`;
  assert.ok(existsSync(join(root, path)), `${path} exists`);
  const ground = read(path).match(/<color key="backgroundColor" red="([\d.]+)" green="([\d.]+)" blue="([\d.]+)"/);
  assert.ok(ground, 'the launch view has a solid ground');
  assert.deepEqual(ground.slice(1).map((v) => Math.round(Number(v) * 255)), [0x19, 0x00, 0x19], '#190019');
  const workflow = read('.github/workflows/ios-native.yml');
  assert.ok(workflow.includes(`= ${name}\n`) && workflow.includes(`${name}.storyboardc`), 'the build check names the same storyboard');
});

test('the iPhone draws its brand surfaces from BrandColor, which is plum', () => {
  const brand = read('apps/ios/App/Shared/BrandColor.swift');
  assert.match(brand, /static let plum = Color\(red: 0x19 \/ 255, green: 0x00 \/ 255, blue: 0x19 \/ 255\)/);
  assert.match(read('apps/ios/App/Views/Splash.swift'), /static let ground = BrandColor\.plum/);
  assert.match(read('apps/ios/App/Shared/PixelCat.swift'), /var fill = BrandColor\.plum/);
  assert.match(read('apps/ios/App/Shared/LiveCardView.swift'), /static let accent = BrandColor\.accentOnDark/);
});

test('Android 12+ opens on the brand plum with the white mark', () => {
  assert.match(read('apps/android/app/src/main/res/values/colors.xml'), /<color name="ic_launcher_background">#FF190019<\/color>/);
  for (const theme of ['values-v31', 'values-night-v31']) {
    assert.match(read(`apps/android/app/src/main/res/${theme}/themes.xml`),
      /windowSplashScreenBackground">@color\/ic_launcher_background</, theme);
  }
});

test('the Android pixel cat is plum with a white line', () => {
  assert.match(read('apps/android/app/src/main/java/com/nekko/android/ui/components/PairSuccess.kt'),
    /fill: Color = Color\(0xFF190019\),\s*line: Color = Color\.White,/);
});

test('the desktop pixel mascot is plum with a white line', () => {
  assert.match(read('apps/desktop/src/renderer/components/Mascot.tsx'), /fill="#190019" stroke="#ffffff"/);
});

test('no app source uses the retired green brand', () => {
  const sources = [
    ...files('apps/ios/App', ['.swift', '.storyboard', '.svg']),
    ...files('apps/ios/Widgets', ['.swift']),
    ...files('apps/android/app/src/main', ['.kt', '.xml']),
    ...files('apps/desktop/src/renderer/components', ['.tsx', '.ts', '.css']).filter((p) => !/\.test\.tsx?$/.test(p)),
  ];
  const hits = sources.flatMap((path) => {
    const text = read(path);
    return legacy.filter((re) => re.test(text)).map((re) => `${path}: ${re}`);
  });
  assert.deepEqual(hits, []);
});
