# SDK smoke tests

## Android

The GitHub Actions workflow **RN demo Android build and SDK smoke** builds a demo-signed release APK and installs it in an Android 15 / API 35 emulator. No Metro server is involved.

The initial run detects the APK's embedded release label (the first demo APK shows `Baseline v1`) and presses **Check for update**. The `ota-demo-android-apk` artifact is the installable APK. Keep its run ID: the Hot Updater native build records a minimum bundle ID, so an OTA published before a freshly rebuilt APK may be ineligible.

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

CI uses a Pixel 2 profile, 3 GB RAM and a 20-second boot settling period. Any Android ANR dialog fails the test explicitly. Changes limited to the E2E script/workflow are tested with a manual run using an existing APK; they do not automatically create a new native baseline.

## iOS simulator

The manually dispatched **RN demo iOS simulator build and SDK smoke** workflow (`.github/workflows/rn-demo-ios.yml`) builds a Release simulator app and exercises its controls through XCTest. It is configured for an Apple Silicon runner, Xcode 16.4, and the iOS 18.5 runtime. Code signing is disabled: neither an Apple Developer account nor signing credentials are required for this simulator app. It cannot be installed on a physical iPhone.

Verified on 2026-09-11: [baseline build and SDK check](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34567165312), [iOS OTA publish](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34567358886), and [same-app OTA application and relaunch persistence](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34567453837). The latter used the original `Baseline v1` app and verified `OTA v2` after downloading and applying it.

### Build a baseline, then reuse it for OTA

1. Run `rn-demo-ios.yml` on `main` with both `app_run_id` and `expected_ota_label` empty. The workflow builds an embedded `Baseline v1` using `IOS_BASELINE_LABEL` and runs the initial SDK check.
2. Keep that run ID and the `ota-demo-ios-simulator` artifact. It contains `OtaDemo-simulator-arm64.tar.gz` and `SHA256SUMS.txt`; the tar archive preserves the `.app` bundle's permissions and symlinks.
3. After the baseline build finishes, publish an iOS bundle with a different visible release label through **RN demo OTA deploy**, selecting `platform=ios` and branch `main`. The normal source push workflow now publishes both Android and iOS sequentially; manual dispatch defaults to `platform=both`, while `platform=ios` remains available for an isolated iOS test.
4. Run `rn-demo-ios.yml` again with `app_run_id` set to the original baseline run ID and `expected_ota_label` set to the exact deployed label, such as `OTA v2`.

The second run downloads and verifies the original archive instead of rebuilding the app. The test asserts the baseline, check for updates, download the SDK-selected bundle, apply it, and verify the new label after reload and another app launch. An expected OTA label requires an `app_run_id`, so a test cannot accidentally prove the new screen merely by embedding it in a fresh native build.

```sh
# First native baseline build; keep its Actions run ID when it finishes.
gh workflow run rn-demo-ios.yml --ref main \
  --repo CheolMinBae/hot-updater-lab

# Publish the current main source as an iOS OTA after that native build.
gh workflow run rn-demo-ota.yml --ref main \
  --repo CheolMinBae/hot-updater-lab -f platform=ios

# Set APP_RUN_ID to the original native build's run ID before this command.
gh workflow run rn-demo-ios.yml --ref main \
  --repo CheolMinBae/hot-updater-lab \
  -f app_run_id="$APP_RUN_ID" -f expected_ota_label='OTA v2'
```

The native app stays at version `1.0.0` and channel `rn-demo`. Platform selection separates its iOS bundle from Android updates. Keep the order **build original `.app` → deploy compatible OTA → test the same `.app`** so the native minimum bundle ID does not move past the update being tested.

### Local simulator use

From this app directory, install the npm dependencies first. Building requires Xcode, the iOS SDK, Ruby 3.3, and Bundler; the helper installs the project's CocoaPods dependencies. Running a previously built `.app` requires Xcode and an available iOS simulator runtime. Finish Xcode's initial setup before running the helpers.

```sh
npm ci
IOS_BASELINE_LABEL='Baseline v1' npm run ios:build:simulator
npm run ios:simulator
npm run ios:simulator -- --list
npm run ios:simulator -- --device 'iPhone 16 Pro Max'
npm run ios:simulator -- --app /path/to/OtaDemo.app
```

The build output is `build/ios/Build/Products/Release-iphonesimulator/OtaDemo.app`. `IOS_BASELINE_LABEL` temporarily sets the embedded release content and restores `src/release.ts` after the build. Omit it to embed the current source. The default architecture follows the local Mac; `IOS_SIMULATOR_ARCH=arm64` or `x86_64` can select it explicitly. The Actions archive is arm64 for Apple Silicon; Intel Macs should build locally.

`ios:simulator` builds only when its default `.app` is absent. `--app` always uses the supplied bundle. It prefers an already booted iPhone, otherwise selects an available iPhone. `--device` accepts a UDID or exact name, and ambiguous names require a UDID from `--list`. `DEVELOPER_DIR` can select a nonstandard Xcode installation. The helper preserves existing app data and OTA downloads; choose a simulator without this demo installed when you need an untouched baseline for a manual comparison.

For automated local verification with a separate test simulator:

```sh
python3 e2e/ios/smoke.py \
  --app build/ios/Build/Products/Release-iphonesimulator/OtaDemo.app \
  --baseline-label 'Baseline v1' \
  --expected-ota-label 'OTA v2'
```

Omit `--expected-ota-label` for the initial baseline check. This runner creates a dedicated iPhone simulator with clean app data and removes that test simulator when it finishes. It does not erase or reuse a personal simulator. `IOS_SIMULATOR_RUNTIME` can select an installed runtime identifier.

### Evidence and scope

The workflow uploads `ota-demo-ios-evidence` with XCTest results (`.xcresult`), screenshot attachments, the final screenshot, simulator logs, and `result.json` containing the executable SHA-256 and test outcome. Artifacts expire after 14 days. The initial build also uploads `ota-demo-ios-simulator` for local installation and subsequent OTA tests.

The iOS build/test workflow has repository and Actions read permissions. OTA publishing remains in the separate deployment workflow with its existing AWS OIDC role. The iOS smoke test covers the manual SDK update flow and persistence; it does not establish physical-device, code-signing, OTA-signature, rollout-cohort, or crash-rollback coverage.
