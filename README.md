# Hot Updater 실험 서버

Hot Updater **0.36.11** 콘솔과 OTA 확인 API를 기존 EC2에서 Docker로 운영하는 실험 환경입니다.
실제 RN 클라이언트는 [apps/ota-demo](apps/ota-demo/README.md)에 있습니다. Android·iOS 네이티브 SDK와 업데이트 확인·다운로드·재시작 화면을 포함합니다.
기존 `lab` 채널의 JavaScript fixture는 전송 진단용이며, RN 앱은 별도의 `rn-demo` 채널을 사용합니다.

## RN 앱 빠른 테스트

1. **RN demo Android build and SDK smoke** Actions에서 Release APK를 받습니다.
2. 앱 설치 후 `apps/ota-demo/src/release.ts`의 문구·색상 또는 `App.tsx`를 수정해 main에 push합니다.
3. **RN demo OTA deploy** 완료 후 앱에서 확인 → 다운로드 → 적용 버튼을 누릅니다.

APK를 먼저 빌드하고 그 이후 OTA를 배포해야 합니다. 같은 APK로 계속 테스트하며, 자세한 설정과 검증 방법은 [RN 앱 안내](apps/ota-demo/README.md)를 참고하세요.

## 접속과 구성

| 항목 | 설정 |
| --- | --- |
| 관리 콘솔 | https://ota.prostacks.net |
| 콘솔 로그인 | HTTP Basic 인증, 사용자 `ota-admin` |
| 앱의 업데이트 확인 주소 | `https://ota.prostacks.net/hot-updater` |
| 상태 확인 | `https://ota.prostacks.net/health` |
| 저장소 | https://github.com/CheolMinBae/hot-updater-lab |
| 서버 | 기존 EC2 `blog-server`, `3.38.188.140`, 서울 리전 |

콘솔 비밀번호는 로컬 비공개 파일로 관리합니다. 저장소, Docker 이미지, Actions 로그에 넣지 않습니다.

```text
브라우저 → HTTPS Nginx + Basic 인증 → 콘솔 컨테이너 :1422 → S3
앱      → HTTPS Nginx /hot-updater → API 컨테이너 :3007 → S3 메타데이터
앱      → API가 반환한 서명 URL → S3 번들 다운로드
GitHub Actions → OIDC 임시 자격증명 → CLI 빌드·S3 업로드·메타데이터 갱신
```

- 두 컨테이너는 같은 이미지이며 호스트의 `127.0.0.1:1422`, `127.0.0.1:3007`에만 연결합니다.
- 기존 Nginx가 HTTPS를 제공하고 Let's Encrypt 인증서를 사용합니다. 콘솔의 화면과 `/_serverFn/*` 전체에 인증이 적용됩니다.
- `/hot-updater`의 확인 API는 공개하지만 번들 관리 API는 비활성화합니다.
- 전용 비공개 S3 버킷의 `metadata/`에 배포 정보, `bundles/`에 파일을 저장합니다. 별도 DB나 Lambda는 사용하지 않습니다.
- 서버는 EC2 IAM 역할을 IMDS로, Actions는 GitHub OIDC 역할로 사용합니다. 고정 AWS 키를 배포하지 않습니다.
- 공식 콘솔 문서는 localhost 사용을 안내합니다. 이 환경은 그 Node 콘솔을 인증 프록시 뒤에 올린 자체 운영 구성입니다.

서버에서 HTTPS 상태 확인 200, 미인증 콘솔 401, 공개 관리 API 404를 확인했습니다.
인증 후 콘솔은 200으로 열렸고 브라우저 JavaScript 오류가 없었으며 두 컨테이너는 healthy 상태였습니다.
2026-09-08 [GitHub Actions 실행](https://github.com/CheolMinBae/hot-updater-lab/actions/runs/34209800998)이 성공했습니다. OIDC 인증, S3 배포, 1,079바이트 번들 다운로드와 SHA-256, 버전·채널 분리 검증이 통과했습니다.
브라우저 콘솔에서 번들 비활성화 → API `ROLLBACK` → 재활성화 → 정상 업데이트 제공도 확인했습니다. 테스트 번들은 활성 상태로 복원했습니다.

## 로컬 개발과 수동 전송 검증

Node.js 22 이상과 전용 버킷에 접근할 AWS 프로필이 필요합니다.
`S3_BUCKET_NAME`은 생성 결과 또는 보관한 상태 파일의 전용 버킷명으로 설정합니다.

```bash
npm ci
export AWS_REGION=ap-northeast-2
export S3_BUCKET_NAME='<전용 버킷명>'
export OTA_BASE_URL=https://ota.prostacks.net
npm run check
npx hot-updater deploy -p android -c lab -t 1.0.0 -m 'Manual transport fixture'
npx tsx scripts/smoke.ts
```

`npm run console`은 로컬 콘솔을, `npm start`는 포트 3007의 API를 실행합니다.
`smoke.ts`는 업데이트 선택, 실제 HTTPS 다운로드와 SHA-256, 버전·채널 분리, 콘솔 인증, 관리 API 차단을 검사합니다.
통과 여부는 실행 출력과 Actions 로그에서 확인합니다.

```bash
npx tsx scripts/smoke.ts --rollback
```

롤백 검사는 이 체크아웃에서 방금 만든 `work/latest-fixture.json`의 번들만 잠시 비활성화하고 원래 상태로 복원합니다.
실제 앱 연결 시에는 `scripts/fixture-build.ts`를 적절한 RN 빌드 플러그인으로 바꾸고, SDK를 포함한 네이티브 앱을 먼저 배포해야 합니다.

## GitHub Actions

`.github/workflows/ota.yml`의 **OTA transport fixture**를 `workflow_dispatch`로 실행할 수 있습니다.
`main`의 fixture, 빌드 설정 또는 워크플로 변경을 푸시해도 실행됩니다. 문서만 수정한 푸시는 배포하지 않습니다.
저장소 변수 `AWS_ROLE_ARN`, `S3_BUCKET_NAME`, `OTA_BASE_URL`이 필요하며 OIDC 신뢰는 해당 저장소의 `main` 브랜치로 제한합니다.

```bash
gh workflow run ota.yml --repo CheolMinBae/hot-updater-lab --ref main
gh run list --repo CheolMinBae/hot-updater-lab --workflow ota.yml --limit 5
```

워크플로는 타입 검사 → OIDC 인증 → Android/lab/1.0.0 fixture 배포 → 전송 검증 순서로 실행합니다.
동시 배포는 직렬화합니다. 실제 RN 빌드·서명·스토어 제출은 이 워크플로에 포함되지 않습니다.

## 서버 운영

서버의 프로젝트 디렉토리에서 `S3_BUCKET_NAME`을 설정한 뒤 실행합니다.

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail 100 console api
```

`compose.yaml`은 재시작 정책, 컨테이너 자원 한도, 로그 회전을 설정합니다.
Nginx 설정은 `infra/ota.nginx.conf`를 참고하며, 기존 다른 서비스의 설정은 유지합니다.

## 종료와 비용

자동 삭제는 설정하지 않았습니다. 테스트 종료 후 먼저 이 프로젝트의 컨테이너를 `docker compose down`으로 중지하고 실행 중인 Actions를 종료합니다.
`work/ec2-storage-state.json`, `work/github-oidc-state.json`은 삭제 완료까지 보관해야 합니다.

```bash
# 상태를 확인한 후, 해당 실험에서 만든 리소스만 명시적으로 삭제합니다.
python3 scripts/github-oidc.py down --bucket "$S3_BUCKET_NAME"
python3 scripts/ec2-storage.py down
python3 scripts/github-oidc.py down --bucket "$S3_BUCKET_NAME" --execute
python3 scripts/ec2-storage.py down --execute
```

스크립트는 보관된 소유 기록에 따라 IAM 역할·프로필·S3를 정리합니다. **기존 EC2와 다른 앱은 삭제하지 않습니다.**
Nginx 가상 호스트·인증 파일·인증서는 이 실험에 해당하는 것만 별도로 정리합니다.
DNS도 별도 명시적 정리가 필요합니다. 호스트존 `Z071113725YQ78WWG1236`에서 `ota.prostacks.net.`의 **A / TTL 300 / 3.38.188.140** 레코드가 현재 값과 정확히 일치하는지 확인한 뒤 그 레코드만 삭제합니다. 호스트존과 다른 레코드는 유지합니다.

소량 테스트의 증분 비용은 S3 저장·요청·전송과 DNS 조회 중심이며 센트 단위를 예상합니다. 실제 금액은 사용량에 따라 달라집니다.
기존 EC2 비용은 테스트 종료 후에도 계속 발생하며, 이 실험에는 Lambda 비용이 없습니다.
