#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv.includes('--help')) {
  console.log('iOS Release 시뮬레이터 앱 빌드\n필수: Xcode, iOS SDK, Ruby 3.3, npm ci\n선택 환경 변수: DEVELOPER_DIR, IOS_SIMULATOR_ARCH, IOS_BASELINE_LABEL\n출력: build/ios/Build/Products/Release-iphonesimulator/OtaDemo.app');
  process.exit(0);
}

const env = {...process.env};
if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer')) {
  env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';
}
// Use a project-scoped toolchain without changing the user's shell configuration.
const rubyVersion = spawnSync('ruby', ['-e', 'print RUBY_VERSION'], {env, encoding: 'utf8'});
const [rubyMajor = 0, rubyMinor = 0] = (rubyVersion.stdout || '').trim().split('.').map(Number);
if (rubyVersion.status !== 0 || rubyMajor < 3 || (rubyMajor === 3 && rubyMinor < 2)) {
  for (const rubyBin of ['/opt/homebrew/opt/ruby@3.3/bin', '/usr/local/opt/ruby@3.3/bin']) {
    if (existsSync(rubyBin)) {
      env.PATH = `${rubyBin}:${env.PATH || ''}`;
      break;
    }
  }
}
env.BUNDLE_GEMFILE = path.join(root, 'Gemfile');
env.NODE_BINARY = process.execPath;
env.RCT_USE_PREBUILT_RNCORE ??= '1';
env.RCT_USE_RN_DEP ??= '1';
env.RCT_NO_LAUNCH_PACKAGER = '1';
env.FORCE_BUNDLING = '1';

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {cwd, env, stdio: 'inherit'});
  if (result.error) {throw result.error;}
  if (result.status !== 0) {throw new Error(`${command} 실행 실패 (exit ${result.status ?? result.signal})`);}
}

const releaseFile = path.join(root, 'src/release.ts');
const backupFile = path.join(root, 'build/ios-baseline-source-backup.ts');
let originalRelease;
let generatedRelease;
function restoreRelease() {
  if (originalRelease === undefined) {return;}
  if (readFileSync(releaseFile, 'utf8') === generatedRelease) {
    writeFileSync(releaseFile, originalRelease);
    unlinkSync(backupFile);
  } else {
    console.warn(`빌드 중 release.ts 변경이 감지되어 덮어쓰지 않았습니다. 빌드 전 원본: ${backupFile}`);
  }
  originalRelease = undefined;
}

process.on('exit', restoreRelease);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

try {
  const xcode = spawnSync('xcodebuild', ['-version'], {env, encoding: 'utf8'});
  if (xcode.status !== 0) {
    throw new Error('Xcode 초기 설정이 필요합니다. App Store에서 Xcode를 설치하고 한 번 실행해 초기 설정을 완료하세요. Command Line Tools만으로는 iOS 시뮬레이터를 빌드할 수 없습니다.');
  }
  console.log(xcode.stdout.trim());
  if (!existsSync(path.join(root, 'node_modules/react-native/package.json'))) {
    throw new Error('앱 디렉터리에서 npm ci를 먼저 실행하세요.');
  }
  const arch = env.IOS_SIMULATOR_ARCH || (process.arch === 'arm64' ? 'arm64' : 'x86_64');
  if (!['arm64', 'x86_64'].includes(arch)) {throw new Error('IOS_SIMULATOR_ARCH는 arm64 또는 x86_64여야 합니다.');}

  run('bundle', ['install']);
  run('bundle', ['exec', 'pod', 'install'], path.join(root, 'ios'));

  if (env.IOS_BASELINE_LABEL) {
    mkdirSync(path.dirname(backupFile), {recursive: true});
    if (existsSync(backupFile)) {throw new Error(`이전 빌드 원본이 남아 있습니다. 먼저 확인하세요: ${backupFile}`);}
    originalRelease = readFileSync(releaseFile, 'utf8');
    generatedRelease = `export const release = ${JSON.stringify({label: env.IOS_BASELINE_LABEL, message: 'This screen is bundled with the installed iOS app.', accent: '#ff8b54'}, null, 2)};\n`;
    writeFileSync(backupFile, originalRelease, {mode: 0o600});
    writeFileSync(releaseFile, generatedRelease);
  }

  run('xcodebuild', [
    '-workspace', 'ios/OtaDemo.xcworkspace', '-scheme', 'OtaDemo',
    '-configuration', 'Release', '-sdk', 'iphonesimulator',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', 'build/ios', `ARCHS=${arch}`,
    'ONLY_ACTIVE_ARCH=YES', 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'build',
  ]);
  const builtApp = path.join(root, 'build/ios/Build/Products/Release-iphonesimulator/OtaDemo.app');
  if (!existsSync(path.join(builtApp, 'Info.plist'))) {throw new Error(`빌드 산출물이 없습니다: ${builtApp}`);}
  console.log(`\n시뮬레이터 앱 빌드 완료: ${builtApp}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  restoreRelease();
}
