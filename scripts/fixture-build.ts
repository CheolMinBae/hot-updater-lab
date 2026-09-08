import { createUUIDv7, type BuildPlugin } from "@hot-updater/plugin-core";
import { build } from "esbuild";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** A deliberately small transport fixture, not a replacement for Metro/RN builds. */
export function fixtureBuild({ cwd }: { cwd: string }): BuildPlugin {
  return {
    name: "transport-fixture-not-react-native",
    async build({ platform }) {
      const bundleId = createUUIDv7();
      const buildPath = path.join(cwd, "work", "build", platform, bundleId);
      await mkdir(buildPath, { recursive: true });
      await build({
        entryPoints: [path.join(cwd, "fixtures", "payload.ts")],
        outfile: path.join(buildPath, `index.${platform}.bundle`),
        bundle: true,
        format: "iife",
        platform: "neutral",
        target: "es2020",
        banner: { js: "/* OTA TRANSPORT FIXTURE — NOT A REACT NATIVE APP */" },
      });

      const fixture = JSON.stringify({
        kind: "hot-updater-transport-fixture",
        bundleId,
        platform,
        createdAt: new Date().toISOString(),
        sourceRevision: process.env.GITHUB_SHA ?? null,
        limitation: "No React Native application or on-device SDK validation.",
      }, null, 2) + "\n";
      await writeFile(path.join(buildPath, "fixture.json"), fixture);
      // Local/CI proof of which bundle this checkout just built. The smoke check
      // also requires this ID to exist and be enabled in the real S3 database.
      await writeFile(path.join(cwd, "work", "latest-fixture.json"), fixture);
      if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, `bundle_id=${bundleId}\n`);
      }
      return {
        buildPath,
        bundleId,
        stdout: "Diagnostic transport fixture built. This is not a React Native app.",
      };
    },
  };
}
