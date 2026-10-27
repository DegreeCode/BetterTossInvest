# BetterTossInvest

[![CI](https://github.com/DegreeCode/BetterTossInvest/actions/workflows/ci-release.yml/badge.svg)](https://github.com/DegreeCode/BetterTossInvest/actions/workflows/ci-release.yml)
[![Release](https://img.shields.io/github/v/release/DegreeCode/BetterTossInvest)](https://github.com/DegreeCode/BetterTossInvest/releases/latest)

[토스증권](https://www.tossinvest.com) PC 웹에 호가선, 중간호가 표시, 차트 조작과 자체 초봉·틱봉을 추가하는 Tampermonkey 스크립트입니다.

**[최신 버전 설치](https://github.com/DegreeCode/BetterTossInvest/releases/latest/download/BetterTossInvest.user.js)** · [릴리스 내역](https://github.com/DegreeCode/BetterTossInvest/releases) · [문제 제보](https://github.com/DegreeCode/BetterTossInvest/issues)

## 설치

1. 브라우저에 [Tampermonkey](https://www.tampermonkey.net/)를 설치합니다.
2. 위의 **최신 버전 설치** 링크를 엽니다.
3. Tampermonkey 설치 화면에서 설치한 뒤 토스증권 페이지를 새로고침합니다.

파일이 다운로드되면 Tampermonkey 대시보드의 **유틸리티 → 파일에서 가져오기**로 `BetterTossInvest.user.js`를 불러오세요. 브라우저에서 사용자 스크립트 실행 권한을 요청하면 허용해야 합니다.

설치 링크는 첫 GitHub Release가 발행된 뒤부터 동작합니다. 저장소에는 개발용 소스만 있으며, 설치 파일은 GitHub Actions가 빌드해 릴리스에 첨부합니다.

### 업데이트

릴리스에 포함된 `@updateURL`과 `@downloadURL`을 통해 새 버전을 확인하고 설치합니다. 확인 간격과 자동 업데이트 여부는 Tampermonkey 설정을 따릅니다. 바로 업데이트하려면 대시보드에서 업데이트 확인을 실행하세요.

이전에 코드를 직접 붙여 넣어 설치했다면 최신 릴리스 파일을 한 번 설치해 업데이트 주소를 적용하세요. 기능 설정은 해당 브라우저의 토스증권 사이트 저장소에 유지됩니다. 중복 항목이 생기면 이전 스크립트를 꺼 주세요.

## 기능

| 기능 | 설명 | 기본값 |
| --- | --- | --- |
| 매수·매도 호가선 | 차트에 현재 최우선 매수·매도 호가를 표시합니다. | 켜짐 |
| 국내주식 중간호가 | KRX·NXT 중간호가와 우세 수량을 표시하고 호가창 안에 행을 추가할 수 있습니다. | 켜짐 |
| 할로우 캔들 복원 | 차트 모양 메뉴에서 할로우 캔들을 선택할 수 있습니다. | 켜짐 |
| 지수 차트 조작 | 지수 상세 차트에서 이동, 확대·축소, 가격축 조절과 차트 모양 선택을 사용합니다. | 켜짐 |
| 초 단위 차트 | 수집한 시세·체결로 1·3·5·10·15·30·60초 봉을 만듭니다. | 꺼짐 |
| 틱 단위 차트 | 체결 건수를 기준으로 10·30·100·300·1,000틱 봉을 만듭니다. | 꺼짐 |
| 실시간 시세 갱신 간격 | 수신한 시세를 화면에 반영하는 기본 배치 간격을 조절합니다. | 켜짐 |

### 설정

토스증권의 **설정 → BetterTossInvest**에서 기능과 세부 값을 바꿉니다. 저장하면 새로고침되며, 항목 이름을 클릭하면 설명을 볼 수 있습니다. **기본값으로 초기화**로 설정을 되돌릴 수 있습니다.

중간호가의 표시 위치·행 높이·수량 표시, 초봉·틱봉의 주기 목록과 체결 보관 한도, 시세 갱신 간격을 조절할 수 있습니다. 갱신 간격의 기본값은 16ms이며, 화면이 느리면 값을 늘려 보세요.

### 초봉과 틱봉

설정에서 기능을 켠 뒤 차트의 **초봉 ∨** 또는 **틱봉 ∨** 버튼으로 주기를 선택합니다. 초봉·틱봉·분봉은 마지막 선택값을 따로 기억합니다. 별도 분봉 메뉴가 없는 지수 화면은 TradingView의 기본 주기 메뉴를 사용합니다.

100틱봉은 체결 100건을 봉 하나로 묶습니다. 한 번에 500주가 체결되어도 건수는 1건이며, 거래량에는 500주를 더합니다. 마지막 미완성 봉도 실시간으로 갱신합니다.

초봉과 틱봉은 페이지가 이미 받은 체결 내역, 화면의 체결 표와 실시간 메시지를 사용합니다. 별도 체결 구독이나 초봉·틱봉용 과거 캔들 요청을 만들지 않습니다. 따라서 처음에는 데이터가 적거나 비어 있을 수 있고, 새로고침하면 모은 데이터가 초기화됩니다. 수집 시작 시점과 공급 데이터에 따라 다른 서비스의 봉과 달라질 수 있습니다.

지수 화면의 틱봉은 나스닥 100·S&P 500·러셀 2000 선물(`RFU.NQc1`, `RFU.ESc1`, `RFU.RTYc1`)에서 지원합니다. 그 밖의 지수에는 틱봉을 제공하지 않습니다.

### 할로우 캔들

차트 모양 메뉴에서 **할로우 캔들**을 선택하세요. 종가가 시가보다 낮으면 몸통을 채우고, 종가가 시가 이상이면 비웁니다. 색상은 이전 봉 종가와 비교하며 토스에서 선택한 색상을 유지합니다.

## 개발

**Node.js 22 이상**이 필요하며 외부 패키지를 설치하지 않습니다.

```sh
git clone https://github.com/DegreeCode/BetterTossInvest.git
cd BetterTossInvest
node scripts/check.mjs
```

검증 명령은 소스를 빌드한 뒤 문법 검사와 전체 회귀 테스트를 실행합니다. 로컬 설치용 파일도 함께 생성됩니다.

```text
src/
  metadata.txt           Tampermonkey 헤더와 배포 버전
  settings.js            기본 설정과 저장된 설정 검증
  core/                  런타임 연결, SPA 이동 처리, 공통 파서
  ui/                    설정 화면
  features/              호가선·중간호가·차트 조작 등 개별 기능
  local-charts/          초봉·틱봉 수집·보관·집계·데이터피드·주기 메뉴
  main.js                기능 등록 및 초기화
scripts/
  build.mjs              단일 스크립트와 업데이트 메타데이터 생성
  check.mjs              빌드·문법·테스트·릴리스 태그 검증
tests/                   호환성 및 회귀 테스트
.github/workflows/       GitHub Actions 검증·릴리스 구성
dist/                    빌드 결과, Git 추적 제외
```

개발용 파일은 빌드할 때 하나의 비공개 함수 범위로 합쳐집니다. 브라우저에서는 설치한 스크립트 하나로 실행되며 개발용 파일을 따로 불러오지 않습니다.

### 빌드 명령

```sh
# 설치 파일과 업데이트 메타데이터 생성
node scripts/build.mjs

# 생성물이 현재 소스와 일치하는지 확인
node scripts/build.mjs --check

# 빌드·문법 검사·전체 테스트
node scripts/check.mjs
```

결과물은 다음 두 파일입니다. `dist/`와 생성물은 커밋하지 않습니다.

| 파일 | 용도 |
| --- | --- |
| `dist/BetterTossInvest.user.js` | Tampermonkey에 설치하는 전체 스크립트 |
| `dist/BetterTossInvest.meta.js` | 새 버전을 확인하는 메타데이터 |

`src/metadata.txt`의 `@version`이 유일한 버전 기준입니다. 실행 중 표시하는 버전과 두 배포 파일의 버전은 빌드가 같은 값으로 생성합니다.

테스트는 TradingView v27/v32 연결, 주기 메뉴, 초봉·틱봉 집계, 중복·지연 체결, 메모리 제한, 실시간 구독과 해제, 호가선 로딩·재시도, 설정 처리와 초기화를 검증합니다. 실제 로그인 화면에서의 호가 표시와 사이트 변경에 대한 확인은 별도로 필요합니다.

## CI/CD와 릴리스

[GitHub Actions](https://github.com/DegreeCode/BetterTossInvest/actions/workflows/ci-release.yml)는 다음 순서로 실행됩니다.

| 실행 계기 | 작업 |
| --- | --- |
| 브랜치 push·Pull Request·수동 실행 | Node.js 22·24에서 빌드, 문법 검사, 전체 테스트 실행 |
| `v*` 태그 push | 위 검증과 함께 태그·스크립트 버전 일치 검사 |
| 태그 검증 전체 통과 | 검증한 두 파일을 첨부한 GitHub Release와 자동 릴리스 노트 생성 |

일반 검증은 저장소 읽기 권한으로 실행합니다. 태그 릴리스 작업에만 `contents: write`를 부여하며, 별도 개인 토큰 없이 기본 `GITHUB_TOKEN`을 사용합니다. 저장소의 Actions 정책에서 사용하는 공식 액션과 릴리스 쓰기 권한이 허용되어 있어야 합니다.

### 새 버전 발행

1. `src/metadata.txt`의 `@version`을 새 버전으로 올립니다. 정식 버전 `MAJOR.MINOR.PATCH` 형식을 사용합니다.
2. `node scripts/check.mjs --tag v새버전`으로 검증합니다.
3. 변경 사항을 커밋하고 push한 뒤, 같은 커밋에 버전 태그를 붙여 push합니다.

예를 들어 버전을 `1.6.5`로 올리고 변경 사항을 커밋한 다음:

```sh
node scripts/check.mjs --tag v1.6.5
git push origin main
git tag -a v1.6.5 -m 'BetterTossInvest 1.6.5'
git push origin v1.6.5
```

태그가 `v1.6.5`인데 메타데이터가 `1.6.4`이면 검증이 실패하고 릴리스하지 않습니다. 테스트 실패 시에도 릴리스하지 않습니다. GitHub Actions의 **Publish release** 완료 후 릴리스의 설치 파일을 확인할 수 있습니다.

### Tampermonkey 업데이트 주소

업데이트 확인은 최신 릴리스의 `BetterTossInvest.meta.js`, 실제 설치는 `BetterTossInvest.user.js`를 사용합니다. 주소는 릴리스마다 바꾸지 않습니다.

```text
https://github.com/DegreeCode/BetterTossInvest/releases/latest/download/BetterTossInvest.meta.js
https://github.com/DegreeCode/BetterTossInvest/releases/latest/download/BetterTossInvest.user.js
```

저장소를 포크해 직접 배포한다면 `src/metadata.txt`의 홈페이지·지원·업데이트·다운로드 주소와 README의 저장소 링크를 자신의 저장소로 바꾸세요.

## 문제 해결

- **설치 링크가 열리지 않음:** GitHub Release에 `BetterTossInvest.user.js`가 첨부되어 있는지 확인하세요. 첫 릴리스 전에는 로컬 빌드 파일을 가져와 설치할 수 있습니다.
- **기능이나 설정 메뉴가 보이지 않음:** Tampermonkey에서 스크립트가 켜져 있고 실행 권한이 있는지 확인한 뒤 페이지를 새로고침하세요.
- **초봉·틱봉이 비어 있음:** 기능을 켰는지 확인하고 유효한 실시간 데이터가 들어올 때까지 기다리세요. 일반 지수에는 틱봉을 제공하지 않습니다.
- **화면이 느리거나 차트가 이상함:** 갱신 간격을 늘리거나 기능을 하나씩 꺼서 확인하세요. 같은 기능의 다른 스크립트와 함께 실행하면 충돌할 수 있습니다.
- **원래 화면으로 복원:** Tampermonkey에서 스크립트를 끄고 새로고침하세요.

문제를 제보할 때는 버전, 브라우저, 페이지 주소, 켜 둔 기능과 재현 순서를 알려 주세요. 첨부 자료의 계좌번호·잔고 등 개인 정보는 가려 주세요.

## 안내 및 라이선스

토스증권의 공식 제품이 아닌 개인 편의용 도구입니다. 주문을 자동 실행하지 않으며, 외부 수집 서버로 계좌·시세 정보를 보내지 않습니다. 호가선 표시를 위해 토스의 차트 파일을 추가로 불러올 수 있습니다. 사이트 변경이나 수신 데이터에 따라 표시 오류·지연이 생길 수 있습니다.

[Apache License 2.0](./LICENSE)으로 배포합니다.
