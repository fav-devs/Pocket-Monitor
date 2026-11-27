// Declares OpenGL ES 3.0, which the native picture renderer (PocketVideoGl) requires on Android.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withGles3(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    const features = (manifest['uses-feature'] ??= []);
    if (!features.some((f) => f.$?.['android:glEsVersion'])) {
      features.push({ $: { 'android:glEsVersion': '0x00030000', 'android:required': 'true' } });
    }
    return cfg;
  });
};
