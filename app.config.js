/**
 * Dynamic Expo config — extends `app.json` with values that can't live in
 * static JSON. Currently used only to inject `android.extraProguardRules`
 * from `plugins/proguard-rules.pro` (Phase 8 of
 * `plans/2026-05-22-audit-remediation-roadmap.md`).
 *
 * Everything else stays in `app.json`. Expo's resolution: this function
 * receives the parsed `app.json` in `context.config` and we patch the
 * `expo-build-properties` plugin's android config.
 *
 * Self-built APKs can set `SUBSTREAMER_ANDROID_PACKAGE` to override the
 * Android application id, so they install alongside the Play/EAS release
 * instead of failing with INSTALL_FAILED_UPDATE_INCOMPATIBLE. When the var is
 * unset the config is byte-for-byte the app.json values (no behaviour change
 * for normal dev, EAS and test builds).
 */
const fs = require('fs');
const path = require('path');

const PROGUARD_RULES_PATH = path.join(__dirname, 'plugins', 'proguard-rules.pro');

module.exports = ({ config }) => {
  const extraProguardRules = fs.readFileSync(PROGUARD_RULES_PATH, 'utf8');

  const plugins = (config.plugins ?? []).map((entry) => {
    if (Array.isArray(entry) && entry[0] === 'expo-build-properties') {
      const [name, options] = entry;
      return [
        name,
        {
          ...options,
          android: {
            ...(options?.android ?? {}),
            extraProguardRules,
          },
        },
      ];
    }
    return entry;
  });

  // The deep-link scheme is deliberately NOT overridden: `substreamer://play?...`
  // is hard-coded in plugins/with-android-app-actions.js (shortcuts.xml) and
  // src/services/voiceDeepLinkMapper.ts. Two installed builds therefore share
  // the scheme (Android shows a chooser for voice deep links) but can coexist.
  const androidPackage = process.env.SUBSTREAMER_ANDROID_PACKAGE;
  const android = androidPackage
    ? { ...(config.android ?? {}), package: androidPackage }
    : config.android;

  return { ...config, android, plugins };
};
