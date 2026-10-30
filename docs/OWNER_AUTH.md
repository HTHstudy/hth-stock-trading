# 단일 소유자 로그인

## 범위와 기본값

계좌·백테스트·Paper 조회/정지/전략 변경 API는 소유자 세션을 요구한다. 인증을 설정하지 않으면 비공개 API는 503 OWNER_NOT_CONFIGURED, 설정했지만 로그인하지 않았으면 401 OWNER_LOGIN_REQUIRED로 차단한다. 인증 상태 조회와 로그인/로그아웃, 생존 확인만 세션 없이 제공한다. 프론트엔드는 인증 확인 전 비공개 화면을 마운트하지 않으며 로그인/설정 안내를 표시한다.

이번 구현은 **신뢰된 로컬 컴퓨터의 단일 소유자**용이다. localhost 접근 제한·전용 Paper 테스트 DB·public bind 차단을 유지한다. production 산출물의 로컬 컨테이너 실행은 [로컬 운영](LOCAL_OPERATIONS.md)의 명시적 LOCAL_CONTAINER_MODE/IPv4 loopback에서만 허용한다. 외부 Vercel/API 공개 배포를 활성화하지 않는다. 인터넷 운영에는 HTTPS·프록시 신뢰 경계·Secure cookie·추가 접근 정책·세션 저장/감사·계정 복구를 별도로 검증해야 한다. 실제 주문은 구현하지 않는다.

## 최초 비밀번호 등록

```bash
corepack pnpm owner:hash
```

TTY에서 16~256자 비밀번호를 두 번 입력한다. 입력 문자는 표시하지 않는다. 비밀번호 인자·환경변수·브라우저 설정으로 원문을 받지 않는다. 명령은 프로젝트 루트의 git-ignored `.env.owner`에 **해시만** 0600 권한으로 생성한다. 기존 파일은 덮어쓰지 않는다. 원문·해시를 콘솔에 출력하지 않는다. 다른 경로로 검토하려면 `--output=/절대/경로`를 지정한다.

API dev/start 명령은 기존 `.env` 뒤에 `.env.owner`를 읽는다. 생성 후 API를 재시작한다. 환경에 이미 있는 OWNER_PASSWORD_HASH가 파일보다 우선한다. `.env.owner`를 커밋하거나 공유·프론트 VITE_* 변수에 넣지 않는다. 개인 비밀번호가 사라진 경우 새 파일을 별도 경로에 만들고 소유자가 확인해 교체/재시작한다. 웹에서 비밀번호를 바꾸거나 자동 복구하는 API는 제공하지 않는다.

대시보드 활성 플래그가 true이면 올바른 OWNER_PASSWORD_HASH가 필수다. 기본 대시보드 플래그는 여전히 false다. 인증 등록·로그인은 시세 수집/worker/거래를 재개하지 않는다. 소유자 등록 정보는 broker API 키와 다르다.

## 저장과 세션

- 비밀번호 해시는 Node crypto.scrypt의 N=131072, r=8, p=1, 16바이트 임의 salt와 64바이트 출력이다. 메모리 상한은 256MiB로 제한하며 정해진 형식/비용만 허용한다. 비교는 timingSafeEqual을 사용한다. 새 외부 의존성은 없다.
- 임의 32바이트 세션 ID는 HttpOnly·SameSite=Strict·Path=/·Max-Age=8시간 cookie로만 보낸다. JSON 응답·로그·localStorage에 세션 ID를 넣지 않는다. 서버 메모리에는 세션 ID의 SHA-256 digest와 만료 정보만 둔다. 사용자 ID/역할을 브라우저가 지정할 수 없다.
- 절대 수명은 8시간, 마지막 인증 HTTP 요청 이후 유휴 수명은 30분이다. 주기적인 상태 조회도 요청 활동으로 계산한다. 새 로그인은 이전 세션을 폐기한다. 로그아웃·서버 종료/재시작 시 세션은 무효다. 한 소유자만 지원하므로 사용자 테이블·OAuth·JWT·Redis를 추가하지 않았다.
- 로컬 HTTP에서 확인하므로 현재 cookie는 Secure가 아니다. 이것을 외부 운영용 cookie 정책으로 사용하지 않는다. Host/Origin/loopback peer/Sec-Fetch-Site와 변경 요청의 x-hth-dashboard 헤더를 계속 검사하며 공개 CORS를 허용하지 않는다.
- 비밀번호 검증은 한 번에 하나만 실행한다. 15분 창에서 5번 실패하면 로그인 검증을 제한한다. busy/제한은 429, 틀린 비밀번호는 일반 401을 반환한다. 로그인 본문은 2048바이트 이하이며 엄격한 Zod 필드 검증을 거친다. 원본 오류나 인증 값은 반환하지 않는다.

기준은 [Node 24 crypto.scrypt](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback), [OWASP 비밀번호 저장](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP 세션 관리](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)를 확인했다. 세부 수명·단일 세션·실패 횟수는 이 개인용 MVP의 선택이다.

## API와 UI

| API                  | 동작                                           |
| -------------------- | ---------------------------------------------- |
| GET /v1/auth/session | configured/authenticated/expiresAt만 제공      |
| POST /v1/auth/login  | 빈 추가 필드 없이 password만 검증, cookie 발급 |
| POST /v1/auth/logout | 현재 세션 폐기·cookie 삭제                     |

로그인 화면은 비밀번호를 query/mutation 캐시나 브라우저 저장소에 보관하지 않고 제출 시 입력칸을 비운다. 비공개 요청에서 401을 받으면 즉시 화면을 잠그고 비공개 조회를 취소·제거한다. 세션 조회 실패도 계좌 화면을 계속 노출하지 않는다. 로그아웃 성공 시 QueryClient 캐시를 비운다.

로그아웃은 **브라우저 세션을 종료**한다. 이미 실행 중인 worker나 이미 접수된 설정 변경을 취소하지 않는다. 모의 실행을 멈추려면 긴급 정지를 사용한다. 전략 저장은 [전략 설정 정책](STRATEGY_SETTINGS.md)에 따라 별도로 실행을 정지한다.

## 검증과 후속

테스트는 합성 비밀번호로 해시/salt·기본 차단·인증 전 조회/정지/변경 거부·cookie 속성·CSRF·만료·세션 회전·위조·중복 cookie·로그아웃·KDF 동시 실행/시도 제한을 검증한다. 기존 API 경계 테스트의 인증 fixture는 test 디렉터리에만 있고 실제 인증 테스트는 원래 createApp을 사용한다. 실제 비밀번호·증권사 API를 테스트에 쓰지 않는다.

소유자 인증은 구현했지만 외부 배포·다중 사용자·MFA·다중 인스턴스 공유 세션은 아직 제공하지 않는다. 이후 실제 시세 source와 Paper 운영 검증을 진행한 뒤 공개 배포 경계를 별도 작업한다.
