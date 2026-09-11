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

iOS는 Xcode와 CocoaPods를 설치한 Mac에서 실행합니다.

```sh
cd ios
bundle install
bundle exec pod install
cd ..
npm run ios -- --mode Release
```

`npm start`, `npm run android`, `npm run ios`의 기본 Debug 모드는 화면 개발에 사용합니다.
**OTA 적용 테스트에는 Release 빌드가 필요합니다.** Debug는 Metro를 사용하며 SDK 업데이트 확인을 생략합니다.

## 화면 수정 → OTA 배포

1. 먼저 APK를 빌드해 기기에 설치합니다.
2. `src/release.ts`의 `label`, `message`, `accent` 또는 `App.tsx`의 화면을 바꿉니다.
3. `main`에 해당 변경을 push하면 **RN demo OTA deploy**가 Android 번들을 빌드해 S3에 등록합니다.
4. 앱에서 확인 → 다운로드 → 적용 버튼을 누르면 화면이 바뀝니다. 네이티브 앱 버전 `1.0.0`은 그대로입니다.

배포 workflow는 저장소의 기존 `AWS_ROLE_ARN`, `S3_BUCKET_NAME` 변수를 사용해 GitHub OIDC로 인증합니다.
콘솔에서 `rn-demo` 채널로 필터링하면 이 앱의 번들을 확인할 수 있습니다.
iOS는 해당 플랫폼의 네이티브 앱을 먼저 설치한 후 workflow의 `platform=ios`로 수동 실행합니다.

로컬 CLI 배포도 가능합니다. `.env.example`을 참고해 버킷/리전을 설정하고 AWS 프로필 또는 역할로 인증합니다.

```sh
npm run ota:android -- -m 'Update demo screen'
# iOS 네이티브 앱을 준비한 경우:
npm run ota:ios -- -m 'Update demo screen'
```

**순서 주의:** SDK는 APK 빌드 시각으로 최소 번들 ID를 만듭니다. 새 APK보다 먼저 배포된 OTA는 선택되지 않을 수 있습니다.
`APK 빌드 → OTA 배포 → 같은 APK로 업데이트 확인` 순서를 지킵니다. 네이티브 모듈/권한 변경은 새 앱 빌드와 새 호환 버전이 필요합니다.

## 검증

```sh
npm run typecheck
npm test -- --runInBand
```

Android CI는 Release APK를 실제 에뮬레이터에 설치해 SDK 요청을 확인합니다.
OTA 배포 후 같은 workflow를 `apk_run_id=<원래 APK 빌드 run ID>`, `expected_ota_label=<새 label>`로 다시 실행하면
기존 APK를 재사용해 다운로드 → SDK reload → 변경 화면 → 앱 재실행 후 유지까지 검증합니다.
자세한 실행 방법은 [E2E 안내](e2e/README.md)를 참고하세요.

현재 데모는 개인 테스트 서버와 연결합니다. iOS 실행/서명 및 번들 서명 검증은 Android 검증과 별개입니다.
