#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, '..');
const defaultApp = path.join(
  appDirectory,
  'build/ios/Build/Products/Release-iphonesimulator/OtaDemo.app',
);
const bundleIdentifier = 'net.prostacks.otademo';

const help = `iPhone 시뮬레이터에 OTA 데모의 Release 앱을 설치하고 실행합니다.

사용법:
  npm run ios:simulator
  npm run ios:simulator -- --list
  npm run ios:simulator -- --device <UDID 또는 정확한 이름>
  npm run ios:simulator -- --app /경로/OtaDemo.app

옵션:
  --app <경로>       미리 빌드한 iOS 시뮬레이터용 .app을 사용합니다.
  --device <값>      사용 가능한 iPhone의 UDID 또는 정확한 이름을 지정합니다.
  --list            사용 가능한 iPhone 시뮬레이터의 이름과 UDID를 표시합니다.
  --help, -h        이 도움말을 표시합니다.

기본 앱이 없으면 ios-build-simulator.mjs로 Release 빌드를 먼저 만듭니다.
기기를 지정하지 않으면 부팅된 iPhone을 우선 사용합니다.
기존 앱 데이터와 다운로드한 OTA 번들은 초기화하지 않습니다.
Xcode와 iOS 시뮬레이터 런타임이 필요합니다.`;

function parseArguments(args) {
  const options = {
    app: undefined,
    device: undefined,
    list: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (argument === '--list') {
      options.list = true;
    } else if (argument === '--app' || argument === '--device') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} 뒤에 값을 지정하세요.`);
      }
      const key = argument.slice(2);
      if (options[key] !== undefined) {
        throw new Error(`${argument}는 한 번만 지정하세요.`);
      }
      options[key] = value;
      index += 1;
    } else {
      throw new Error(`알 수 없는 옵션: ${argument}. --help를 확인하세요.`);
    }
  }
  return options;
}

function developerDirectory() {
  const requested = process.env.DEVELOPER_DIR;
  const candidate = requested || '/Applications/Xcode.app/Contents/Developer';
  const resolved = path.resolve(candidate);
  const directory = existsSync(path.join(resolved, 'Contents/Developer'))
    ? path.join(resolved, 'Contents/Developer')
    : resolved;
  if (!existsSync(path.join(directory, 'Applications/Simulator.app'))) {
    throw new Error(
      requested
        ? `DEVELOPER_DIR에 iOS 시뮬레이터를 포함한 Xcode가 없습니다: ${requested}`
        : 'Xcode가 없습니다. App Store에서 Xcode를 설치한 뒤 한 번 열어 초기 설정과 iOS 런타임 설치를 완료하세요.',
    );
  }
  return directory;
}

function run(command, args, environment, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: appDirectory,
    env: environment,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`${command} 실행 실패: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || '').trim() : '';
    throw new Error(
      `${command} ${args.join(' ')} 실행 실패${
        result.signal ? ` (${result.signal})` : ` (종료 코드 ${result.status})`
      }${detail ? `\n${detail}` : ''}`,
    );
  }
  return result.stdout || '';
}

function availableDevices(environment) {
  let inventory;
  try {
    inventory = JSON.parse(
      run('xcrun', ['simctl', 'list', '--json'], environment, {
        capture: true,
      }),
    );
  } catch (error) {
    throw new Error(
      `시뮬레이터 목록을 읽지 못했습니다. Xcode의 초기 설정과 라이선스 동의를 완료했는지 확인하세요.\n${error.message}`,
    );
  }
  const runtimes = (inventory.runtimes || []).filter(
    runtime =>
      runtime.identifier?.startsWith(
        'com.apple.CoreSimulator.SimRuntime.iOS-',
      ) && runtime.isAvailable === true,
  );
  if (runtimes.length === 0) {
    throw new Error(
      '사용 가능한 iOS 런타임이 없습니다. Xcode > Settings > Components에서 iOS 시뮬레이터 런타임을 설치하세요.',
    );
  }
  const devices = runtimes.flatMap(runtime =>
    (inventory.devices?.[runtime.identifier] || [])
      .filter(
        device =>
          device.isAvailable === true &&
          (device.deviceTypeIdentifier?.startsWith(
            'com.apple.CoreSimulator.SimDeviceType.iPhone-',
          ) ||
            (!device.deviceTypeIdentifier && device.name.startsWith('iPhone'))),
      )
      .map(device => ({ ...device, runtime: runtime.name })),
  );
  if (devices.length === 0) {
    throw new Error(
      '사용 가능한 iPhone 시뮬레이터가 없습니다. Xcode의 Window > Devices and Simulators에서 iPhone을 만든 뒤 다시 실행하세요.',
    );
  }
  return devices;
}

function deviceList(devices) {
  return devices
    .map(
      device =>
        `  ${device.udid}  ${device.name} · ${device.runtime} · ${device.state}`,
    )
    .join('\n');
}

function selectDevice(devices, requested) {
  if (!requested) {
    return devices.find(device => device.state === 'Booted') || devices[0];
  }
  const matches = devices.filter(
    device =>
      device.udid.toLowerCase() === requested.toLowerCase() ||
      device.name === requested,
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    throw new Error(
      `이름이 같은 시뮬레이터가 여러 개입니다. --device에 UDID를 지정하세요.\n${deviceList(
        matches,
      )}`,
    );
  }
  throw new Error(
    `사용 가능한 iPhone을 찾을 수 없습니다: ${requested}\n${deviceList(
      devices,
    )}`,
  );
}

function assertApp(appPath) {
  if (
    !appPath.endsWith('.app') ||
    !existsSync(appPath) ||
    !statSync(appPath).isDirectory()
  ) {
    throw new Error(
      `iOS 시뮬레이터용 .app 디렉터리를 찾을 수 없습니다: ${appPath}`,
    );
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(help);
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('iOS 시뮬레이터는 Xcode가 설치된 macOS에서 실행하세요.');
  }
  const developer = developerDirectory();
  const environment = { ...process.env, DEVELOPER_DIR: developer };
  const devices = availableDevices(environment);
  if (options.list) {
    console.log(`사용 가능한 iPhone 시뮬레이터:\n${deviceList(devices)}`);
    return;
  }
  const device = selectDevice(devices, options.device);
  const appPath = options.app
    ? path.resolve(process.cwd(), options.app)
    : defaultApp;
  if (!options.app && !existsSync(appPath)) {
    console.log('Release 앱이 없어 시뮬레이터용 앱을 빌드합니다.');
    run(
      process.execPath,
      [path.join(scriptDirectory, 'ios-build-simulator.mjs')],
      environment,
    );
  }
  assertApp(appPath);
  console.log(
    `${device.name} (${device.runtime}, ${device.udid})에서 실행합니다.`,
  );
  if (device.state !== 'Booted' && device.state !== 'Booting') {
    run('xcrun', ['simctl', 'boot', device.udid], environment);
  }
  run(
    'open',
    [
      '-a',
      path.join(developer, 'Applications/Simulator.app'),
      '--args',
      '-CurrentDeviceUDID',
      device.udid,
    ],
    environment,
  );
  run('xcrun', ['simctl', 'bootstatus', device.udid, '-b'], environment);
  run('xcrun', ['simctl', 'install', device.udid, appPath], environment);
  run(
    'xcrun',
    [
      'simctl',
      'launch',
      '--terminate-running-process',
      device.udid,
      bundleIdentifier,
    ],
    environment,
  );
  console.log(
    'OTA 데모를 실행했습니다. 앱에서 Check for update를 눌러 확인하세요.',
  );
  console.log('기존 앱 데이터와 OTA 번들은 유지했습니다.');
}

try {
  main();
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
}
