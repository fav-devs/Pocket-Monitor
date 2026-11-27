// Copies SN Pro into the Live Activity extension (targets/pocket-live/Fonts) at prebuild, so the
// Lock Screen and Dynamic Island use the app's type. The extension folder is a synchronized Xcode
// group (@bacons/apple-targets), so the files become extension resources; Info.plist `UIAppFonts`
// registers them. The copies are git-ignored: node_modules stays the single source.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

const FACES = [
  ['500Medium/SNPro_500Medium.ttf', 'SNPro-Medium.ttf'],
  ['600SemiBold/SNPro_600SemiBold.ttf', 'SNPro-SemiBold.ttf'],
  ['700Bold/SNPro_700Bold.ttf', 'SNPro-Bold.ttf'],
];

module.exports = function withLiveActivityFonts(config, { target = 'targets/pocket-live' } = {}) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const pkg = path.dirname(require.resolve('@expo-google-fonts/sn-pro/package.json', { paths: [root] }));
      const dir = path.join(root, target, 'Fonts');
      fs.mkdirSync(dir, { recursive: true });
      for (const [from, to] of FACES) {
        const src = path.join(pkg, from);
        const dst = path.join(dir, to);
        const same = fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size;
        if (!same) fs.copyFileSync(src, dst);
      }
      return cfg;
    },
  ]);
};
