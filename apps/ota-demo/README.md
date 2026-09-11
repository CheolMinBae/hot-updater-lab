# Hot Updater RN 데모

React Native **0.85.2 / React 19.2.3 / Hot Updater SDK 0.36.11**로 만든 실제 Android·iOS 앱입니다.
서버는 `https://ota.prostacks.net/hot-updater`, 네이티브 앱 버전은 `1.0.0`, 채널은 `rn-demo`입니다.
루트의 `fixtures/payload.ts`와 `lab` 채널은 기존 전송 진단용이며 이 앱에서 받지 않습니다.

## 앱에서 확인할 수 있는 것

- 실행 중인 화면 버전, 네이티브 앱 버전, 채널, 시작 시점의 번들 ID
- `Check for update` → `Download update` → `Apply and restart`
- SDK 다운로드 진행률, 실패 후 재시도, 서버에서 내려주는 롤백 처리
- 네트워크 오류를 “업데이트 없음”과 구분

서버가 플랫폼·앱 버전·채널·최소 번들 ID·활성화 상태 등을 보고 적용할 번들을 선택합니다.
앱은 SDK가 반환한 번들을 다운로드하고 재시작합니다. 콘솔 비밀번호와 AWS 자격 증명은 앱에 들어가지 않습니다.

## 설치와 실행

이 디렉터리에서 Node 22.13 이상으로 `npm ci`를 실행합니다.

Android 로컬 개발에는 JDK 17 및 Android SDK가 필요합니다.

```sh
npm run android:release
adb install android/app/build/outputs/apk/release/app-release.apk
```

GitHub Actions의 **RN demo Android build and SDK smoke**도 설치 가능한 APK와 에뮬레이터 검증 증거를 제공합니다.
APK는 테스트용 공개 debug 키로 서명한 **Release 모드** 빌드입니다. 스토어 배포용 서명은 별도로 구성해야 합니다.

### iOS 시뮬레이터

Mac에 Xcode와 iOS 시뮬레이터 런타임을 설치하고 Xcode의 초기 설정을 완료합니다.
로컬 빌드에는 Ruby 3.3과 Bundler도 필요합니다. 빌드 스크립트가 이 앱의 Gemfile로 CocoaPods를 설치하고 `pod install`을 실행합니다.
시뮬레이터용 **Release** 앱은 코드 서명 없이 빌드하므로 Apple Developer 계정이나 배포 인증서가 필요하지 않습니다.
이 산출물은 실제 iPhone에 설치하는 IPA가 아닙니다.

```sh
npm run ios:build:simulator
npm run ios:simulator

# 사용 가능한 iPhone의 이름·런타임·UDID 확인
npm run ios:simulator -- --list

# UDID 또는 목록에 나온 정확한 이름으로 선택
npm run ios:simulator -- --device 'iPhone 16 Pro Max'

# 미리 빌드했거나 Actions에서 받은 시뮬레이터 앱 실행
npm run ios:simulator -- --app /경로/OtaDemo.app
```

기본 출력은 `build/ios/Build/Products/Release-iphonesimulator/OtaDemo.app`입니다.
`ios:simulator`는 이 앱이 없을 때만 빌드하며, 기기를 지정하지 않으면 이미 부팅된 iPhone을 우선 사용합니다.
같은 이름의 기기가 여러 개면 `--device`에 UDID를 지정해야 합니다.
설치·재실행할 때 기존 앱 데이터와 이미 받은 OTA 번들을 유지합니다.
Xcode를 다른 경로에 설치했다면 `DEVELOPER_DIR`로 해당 Xcode의 `Contents/Developer`를 지정합니다.

GitHub Actions의 **RN demo iOS simulator build and SDK smoke** (`rn-demo-ios.yml`)는 수동 실행합니다.
첫 실행에서는 `app_run_id`, `expected_ota_label`을 비워 두면 `Baseline v1`을 포함한 앱을 빌드하도록 구성되어 있습니다.
`ota-demo-ios-simulator` 아티팩트에는 **Apple Silicon용 arm64** 앱을 담은 `OtaDemo-simulator-arm64.tar.gz`와 SHA-256 파일이 들어갑니다.
다운로드한 tar 파일을 압축 해제한 뒤 위 `--app` 옵션으로 실행합니다. Intel Mac에서는 로컬 빌드로 준비하세요.
Actions 아티팩트 보존 기간은 14일입니다. 아래 검증 결과의 첫 iOS 빌드에서 설치 파일을 받을 수 있습니다.

로컬에서 OTA 전후 화면을 비교하려면 먼저 다음과 같이 설치 앱의 표시만 `Baseline v1`으로 빌드할 수 있습니다.

```sh
IOS_BASELINE_LABEL='Baseline v1' npm run ios:build:simulator
npm run ios:simulator
```

이 옵션은 빌드 중에만 `src/release.ts`를 바꾸고 원래 소스로 복원합니다.
그다음 다른 label의 소스를 iOS OTA로 배포하고 **같은 `.app`을 재사용**해 업데이트를 확인합니다.
이미 OTA가 적용된 기기에서는 설치만으로 초기 화면으로 돌아가지 않으므로, 전후 비교에는 아직 이 데모를 설치하지 않은 시뮬레이터를 선택하세요.

`npm start`, `npm run android`, `npm run ios`의 기본 Debug 모드는 화면 개발에 사용합니다.
**OTA 적용 테스트에는 Release 빌드가 필요합니다.** Debug는 Metro를 사용하며 SDK 업데이트 확인을 생략합니다.

## 화면 수정 → OTA 배포

1. 먼저 APK를 빌드해 기기에 설치합니다.
2. `src/release.ts`의 `label`, `message`, `accent` 또는 `App.tsx`의 화면을 바꿉니다.
3. `main`에 해당 변경을 push하면 **RN demo OTA deploy**가 Android 번들을 빌드해 S3에 등록합니다.
4. 앱에서 확인 → 다운로드 → 적용 버튼을 누르면 화면이 바뀝니다. 네이티브 앱 버전 `1.0.0`은 그대로입니다.

배포 workflow는 저장소의 기존 `AWS_ROLE_ARN`, `S3_BUCKET_NAME` 변수를 사용해 GitHub OIDC로 인증합니다.
콘솔에서 `rn-demo` 채널로 필터링하면 이 앱의 번들을 확인할 수 있습니다.
iOS는 해당 플랫폼의 네이티브 앱을 먼저 설치한 후 **RN demo OTA deploy** (`rn-demo-ota.yml`)에서 `platform=ios`, branch `main`으로 수동 실행합니다.
CLI로는 다음과 같습니다. 소스 push에 의한 자동 배포는 Android만 대상으로 합니다.

```sh
gh workflow run rn-demo-ota.yml --ref main \
  --repo CheolMinBae/hot-updater-lab -f platform=ios
```

로컬 CLI 배포도 가능합니다. `.env.example`을 참고해 버킷/리전을 설정하고 AWS 프로필 또는 역할로 인증합니다.

```sh
npm run ota:android -- -m 'Update demo screen'
# iOS 네이티브 앱을 준비한 경우:
npm run ota:ios -- -m 'Update demo screen'
```

**순서 주의:** SDK는 네이티브 빌드에서 최소 번들 ID를 정합니다. 새 앱보다 먼저 배포된 OTA는 선택되지 않을 수 있습니다.
`APK 또는 시뮬레이터 .app 빌드 → OTA 배포 → 같은 설치 파일로 업데이트 확인` 순서를 지킵니다.
네이티브 모듈/권한 변경은 새 앱 빌드와 새 호환 버전이 필요합니다.

## 검증

```sh
npm run typecheck
npm test -- --runInBand
```

Android CI는 Release APK를 실제 에뮬레이터에 설치해 SDK 요청을 확인합니다.
OTA 배포 후 같은 workflow를 `apk_run_id=<원래 APK 빌드 run ID>`, `expected_ota_label=<새 label>`로 다시 실행하면
기존 APK를 재사용해 다운로드 → SDK reload → 변경 화면 → 앱 재실행 후 유지까지 검증합니다.
iOS도 **RN demo iOS simulator build and SDK smoke**를 `app_run_id=<처음 .app을 만든 run ID>`,
`expected_ota_label=<배포한 label>`로 다시 실행하도록 구성되어 있습니다. 이 실행은 기존 `.app`을 다운로드해 재사용하며 네이티브 앱을 다시 빌드하지 않습니다.
자세한 실행 방법은 [E2E 안내](e2e/README.md)를 참고하세요.

현재 데모는 개인 테스트 서버와 연결합니다. iOS 시뮬레이터 결과는 Android 검증과 별개로 기록하며,
실제 iPhone 배포 서명과 OTA 번들 서명 검증은 별도로 준비해야 합니다.

### 2026-09-11 검증 결과

- [첫 APK 빌드 및 SDK 확인 성공](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34563148929): 이 run의 `ota-demo-android-apk`가 `Baseline v1` 설치 파일입니다.
- [OTA v2 배포 성공](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34563564691): 번들 ID `01a08ecb-e322-72db-ba12-7fd7c088401c`.
- [동일 APK의 OTA 적용·재실행 유지 검증 성공](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34564057641): SDK 확인 → 다운로드 → 재시작 → `OTA v2` 표시 → 종료/재실행 후 `OTA v2` 유지.
- Android 15 / API 35 에뮬레이터에서 검증했습니다. 서명 검증과 장애 롤백은 이번 검증 범위에 포함하지 않습니다.
- APK SHA-256: `0ff994263c7e630ef3841c33b6c69884b98dcc91d5abf17ae581493129c404f3`.

현재 소스는 `OTA v2` 화면입니다. OTA 전후 비교를 바로 하려면 위 첫 빌드의 APK를 설치하세요. Actions 아티팩트 보존 기간은 14일입니다.

### iOS 시뮬레이터 검증 결과 (2026-09-11)

- [첫 iOS Release 빌드 및 SDK 확인 성공](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34567165312): `ota-demo-ios-simulator`가 `Baseline v1` 설치 파일입니다.
- [iOS OTA v2 배포 성공](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34567358886): 번들 ID `01a08f02-b35c-7a34-9a30-4cf71b75963b`.
- [같은 .app의 OTA 적용·재실행 유지 성공](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34567453837): `Baseline v1` 확인 → SDK 다운로드 → 적용 → `OTA v2` 표시 → 종료/재실행 후 유지.
- Xcode 16.4 / iOS 18.5 / iPhone 16 Pro Max / Apple Silicon 시뮬레이터에서 검증했습니다.
- `.tar.gz` SHA-256: `d08170cea82e95f6f272747f98d276e47fc1cc30cb107ec26eaef41714b46f55`.

이 결과는 GitHub의 Mac 시뮬레이터에서 수행한 것입니다. 로컬 실행에는 Xcode 초기 설정과 iOS 런타임이 필요합니다. 실제 iPhone 설치·서명, OTA 서명 검증과 장애 롤백은 별도 검증 대상입니다.
