/** Diagnostic payload only: this is not an executable React Native application. */
export const fixtureKind = "hot-updater-transport-fixture";

export function describeFixture() {
  return {
    kind: fixtureKind,
    message: "GitHub Actions → Hot Updater → S3 → HTTPS download",
    limitation: "Verifies OTA transport only; no React Native app or SDK is included.",
  };
}

console.info(describeFixture());
