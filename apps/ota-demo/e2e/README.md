# Android SDK smoke test

The GitHub Actions workflow **RN demo Android build and SDK smoke** builds a demo-signed release APK and installs it in an Android 15 / API 35 emulator. No Metro server is involved.

The initial run checks `Baseline v1` and presses **Check for update**. The `ota-demo-android-apk` artifact is the installable APK. Keep its run ID: the Hot Updater native build records a minimum bundle ID, so an OTA published before a freshly rebuilt APK may be ineligible.

To verify an OTA end to end:

1. Wait for the initial APK build to finish.
2. Publish a compatible bundle with a different visible release label, such as `OTA v2`.
3. Run the Android workflow manually with `apk_run_id` set to the original build run ID and `expected_ota_label` set to `OTA v2`.

The second run downloads that original APK, checks the baseline, presses the SDK's check, download and restart controls, then verifies the new label. It also force-stops and relaunches the app to confirm the applied bundle persists. The test fails if the expected OTA is unavailable, the UI reports an error, or the label does not change.

Each run uploads `ota-demo-android-evidence`, containing screenshots, UI hierarchy XML, `result.json` with the APK SHA-256, and emulator logcat. Artifacts expire after 14 days.

For an already running emulator, from this app directory:

```sh
python3 e2e/android_smoke.py \
  --apk android/app/build/outputs/apk/release/app-release.apk \
  --expected-ota-label 'OTA v2'
```

Omit the expected label for the initial check. `ANDROID_SERIAL` can select a different emulator or a dedicated test device. The script clears this demo application's data before testing.

The workflow has only repository/content read permissions and does not deploy bundles or receive AWS credentials. The APK uses the standard React Native demo/debug signing key, not a production signing identity. This test covers the explicit SDK update path and persistence; it does not claim iOS, rollout-cohort, signature, or crash-rollback coverage.
