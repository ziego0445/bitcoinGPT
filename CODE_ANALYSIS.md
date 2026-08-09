# bitcoinGPT 코드 분석

작성일: 2026-08-10

## 1. 프로젝트 개요

이 저장소는 Next.js App Router 기반의 비트코인 단기 트레이딩 보조 웹앱입니다. 첫 화면에서 아래 기능을 한 번에 보여주는 대시보드 형태입니다.

- TradingView 비트코인 5분봉 차트 표시
- Binance 5분봉 캔들 데이터 기반 매수 신호 계산
- OpenAI API를 이용한 차트/시장 분석 문구 생성
- Firebase Firestore 기반 커뮤니티 게시글 작성 및 조회

현재 코드는 초기 프로토타입 성격이 강합니다. 기능은 한 화면에 모여 있고, 외부 API 호출과 UI 상태 관리가 대부분 클라이언트 컴포넌트 안에 직접 들어 있습니다.

## 2. 기술 스택

- Framework: Next.js 15.1.0, React 19
- Language: TypeScript
- Styling: Tailwind CSS
- Chart: TradingView widget script
- Market data: Binance public REST API
- AI: OpenAI Node SDK
- Database: Firebase Firestore
- Image capture: html2canvas
- Package manager: pnpm lockfile 존재

## 3. 파일 구조

```text
app/
  components/
    BitcoinChart.tsx       # TradingView 위젯 로드 및 차트 표시
    CommunityFeed.tsx      # Firestore 게시글 작성/조회 UI
    Header.tsx             # 상단 헤더
    TradingSignals.tsx     # Binance 데이터 조회, 신호 계산, OpenAI 분석
  firebase.ts              # Firebase 앱 및 Firestore 초기화
  globals.css              # 전역 CSS 및 Tailwind import
  layout.tsx               # 루트 레이아웃, 메타데이터
  page.tsx                 # 메인 대시보드 조립
public/                    # 기본 Next 정적 아이콘
```

## 4. 화면 구성 흐름

`app/page.tsx`가 전체 화면을 구성합니다.

1. `Header`를 표시합니다.
2. `TradingSignals`에서 매매 신호와 AI 분석 영역을 표시합니다.
3. `BitcoinChart`에서 TradingView 차트를 표시합니다.
4. `CommunityFeed`에서 커뮤니티 피드를 표시합니다.

현재 페이지는 서버 컴포넌트이고, 실제 동적 기능은 모두 `"use client"` 컴포넌트에서 처리합니다.

## 5. 핵심 컴포넌트 분석

### 5.1 `TradingSignals.tsx`

역할:

- Binance API에서 `BTCUSDT` 5분봉 4개를 가져옵니다.
- 직전 3개 봉의 하락 추세와 총 하락률을 계산합니다.
- 조건이 맞으면 `BUY` 신호를 생성합니다.
- TradingView 차트 DOM을 `html2canvas`로 캡처하려고 시도합니다.
- OpenAI API로 간단한 분석 문구를 생성합니다.
- 수동 분석 버튼을 제공합니다.

현재 신호 조건:

- 최근 3개 캔들의 종가가 계속 낮아짐
- 3개 봉 전체 하락률이 `-1%` 이하
- 조건 충족 시 매수 신호 생성

주의점:

- OpenAI SDK가 브라우저에서 `dangerouslyAllowBrowser: true`로 실행됩니다.
- `NEXT_PUBLIC_OPENAI_API_KEY`는 브라우저 번들에 노출되는 값이라 실제 서비스에는 위험합니다.
- `captureChart()`는 캡처 이미지를 만들지만 OpenAI 요청에는 이미지를 보내지 않습니다. 현재 AI 분석은 텍스트 데이터만 사용합니다.
- `chartData[1]`, `chartData[0]`에 직접 접근하므로 Binance 응답 길이가 예상보다 짧으면 런타임 오류가 날 수 있습니다.
- 초기 더미 신호가 `useEffect` 안에서 설정된 직후 `checkSignals()`가 실행되어 실제 조건에 따라 바로 사라질 수 있습니다.
- `SELL`, `NEUTRAL` 타입은 타입에는 있지만 실제 분기에서는 거의 사용되지 않습니다.
- 문자열 대부분이 인코딩 깨짐 상태입니다.

### 5.2 `BitcoinChart.tsx`

역할:

- TradingView 외부 스크립트 `https://s3.tradingview.com/tv.js`를 동적으로 로드합니다.
- `BINANCE:BTCUSDT` 5분봉 차트를 표시합니다.
- RSI, 단순 이동평균 지표를 추가합니다.
- 생성된 위젯을 `window.tvWidget`에 보관합니다.

주의점:

- 스크립트 로딩 실패 처리가 없습니다.
- 컴포넌트가 다시 마운트될 때 기존 TradingView 컨테이너 내부 정리 로직이 부족할 수 있습니다.
- `_ready` 같은 내부 속성에 의존합니다. TradingView 위젯 구현 변경에 취약합니다.
- `takeScreenshot` 타입은 정의되어 있지만 실제 호출되지는 않습니다.
- `html2canvas`로 iframe 기반 TradingView 차트를 안정적으로 캡처하기 어려울 수 있습니다.

### 5.3 `CommunityFeed.tsx`

역할:

- Firestore `posts` 컬렉션에서 최신 게시글 10개를 불러옵니다.
- 스크롤 하단 접근 시 추가 게시글을 페이지네이션으로 가져옵니다.
- 작성자 이름을 `localStorage`에 저장합니다.
- 새 게시글을 Firestore에 추가합니다.

주의점:

- `onSnapshot`을 import하지만 사용하지 않습니다.
- `loadInitialPosts()`와 `loadMorePosts()`에 Firestore 오류 UI가 없습니다.
- `setLastVisible(snapshot.docs[snapshot.docs.length - 1])`는 빈 결과일 때 `undefined`가 들어갈 수 있습니다.
- `setHasMore(snapshot.docs.length === 10 && posts.length < 50)`에서 `posts.length`는 오래된 클로저 값일 수 있습니다.
- 입력값 길이 제한, 욕설/스팸 방지, 인증, Firestore 보안 규칙 연동이 없습니다.
- 게시글 렌더링 시 Firestore 데이터 형식이 예상과 다르면 `timestamp.toDate()`에서 오류가 날 수 있습니다.

### 5.4 `firebase.ts`

역할:

- Firebase 앱을 초기화하고 Firestore 인스턴스를 export합니다.

주의점:

- Firebase 설정값이 코드에 하드코딩되어 있습니다. Firebase 웹 설정 자체는 공개될 수 있지만, Firestore 보안 규칙이 열려 있다면 데이터 오남용 위험이 큽니다.
- 환경변수 기반 설정으로 옮기면 배포 환경 관리가 쉬워집니다.
- 주석과 문자열이 깨져 있어 유지보수성이 낮습니다.

### 5.5 `layout.tsx`, `Header.tsx`

역할:

- 전역 폰트, 다크 테마, 문서 메타데이터, 상단 제목을 담당합니다.

주의점:

- `metadata.title`, `metadata.description`, 헤더 텍스트가 인코딩 깨짐 상태입니다.
- `layout.tsx`의 `import type React from "react"` 주석이 불필요합니다.

## 6. 데이터 흐름

```text
브라우저
  ├─ Binance API 호출
  │   └─ 5분봉 캔들 데이터 수신
  │       └─ 하락 추세 판단
  │           └─ 매수 신호 상태 업데이트
  │
  ├─ TradingView script 로드
  │   └─ iframe/widget 차트 렌더링
  │
  ├─ OpenAI API 호출
  │   └─ 분석 텍스트 수신
  │
  └─ Firebase Firestore 호출
      ├─ posts 조회
      └─ posts 작성
```

현재는 별도 서버 API 라우트가 없고, 외부 서비스 호출이 전부 클라이언트에서 실행됩니다.

## 7. 현재 주요 리스크

### 높음

- OpenAI API 키가 `NEXT_PUBLIC_` 환경변수로 브라우저에 노출될 수 있습니다.
- OpenAI SDK의 브라우저 직접 사용은 비용 남용 및 키 유출 위험이 큽니다.
- Firestore 쓰기가 인증 없이 가능해 보이며, 보안 규칙이 느슨하면 스팸/삭제/비용 문제가 발생할 수 있습니다.
- 앱 내 한국어 텍스트가 대부분 깨져 사용자 경험과 유지보수성이 크게 떨어집니다.

### 중간

- Binance, TradingView, OpenAI, Firestore 장애 시 사용자에게 명확한 실패 상태를 보여주지 않습니다.
- 차트 캡처 기능은 iframe/CORS 특성상 안정성이 낮을 수 있습니다.
- `TradingSignals`가 신호 계산, API 호출, AI 호출, 캡처, UI 렌더링을 모두 담당해 수정 영향 범위가 큽니다.
- ESLint unused-vars가 파일별로 비활성화되어 사용하지 않는 import와 코드가 누적되어 있습니다.

### 낮음

- README가 기본 create-next-app 문서 그대로입니다.
- Tailwind 설정에 shadcn 스타일 CSS 변수 색상들이 있으나 `globals.css`에는 해당 CSS 변수가 정의되어 있지 않습니다.
- `package.json`의 `lint` 스크립트가 Next 15 환경에서 의도대로 동작하는지 확인이 필요합니다.

## 8. 수정 우선순위 제안

1. 깨진 한국어 문자열 복구
2. OpenAI 호출을 서버 API Route로 이동
3. 환경변수 정리: OpenAI, Firebase 설정 분리
4. Binance 응답 검증 및 에러/로딩 UI 추가
5. Firestore 게시글 로딩/페이지네이션 안정화
6. `TradingSignals`를 데이터 훅, 신호 계산 함수, UI 컴포넌트로 분리
7. `CommunityFeed` 입력 검증, 최대 길이, 실패 메시지 추가
8. README를 실제 프로젝트 설명으로 갱신
9. ESLint 비활성화 제거 및 타입 오류 정리
10. 빌드/린트 확인

## 9. 추천 리팩터링 방향

### 서버 API 라우트 추가

OpenAI 호출은 아래처럼 서버 API 라우트로 이동하는 것이 좋습니다.

```text
app/api/analyze/route.ts
```

클라이언트는 Binance 요약 데이터 또는 서버에서 안전하게 만들 수 있는 분석 입력만 전송하고, 서버에서 `OPENAI_API_KEY`를 사용해 OpenAI API를 호출합니다.

### 순수 함수 분리

신호 계산은 UI와 분리하면 테스트하기 쉬워집니다.

```text
app/lib/signals.ts
```

예상 함수:

- `parseKlines(raw): KlineData[]`
- `calculateTrend(candles): TrendResult`
- `calculatePrices(currentPrice, direction): PricePlan`
- `createSignal(candles): SignalData | null`

### Firestore 접근 분리

Firestore 쿼리와 UI 상태를 분리하면 커뮤니티 피드 수정이 쉬워집니다.

```text
app/lib/posts.ts
```

예상 함수:

- `fetchInitialPosts(limit)`
- `fetchMorePosts(cursor, limit)`
- `createPost({ author, content })`

## 10. 테스트 관점

현재 테스트 파일은 없습니다. 우선순위 높은 테스트 후보는 다음과 같습니다.

- Binance kline 응답 파싱
- 하락 추세 판단
- 매수 신호 생성 조건
- 진입가/목표가 계산
- Firestore 빈 결과 페이지네이션 처리

UI 테스트까지 바로 추가하지 않더라도, 신호 계산 로직만 순수 함수로 분리해 단위 테스트를 붙이면 이후 수정이 훨씬 안전해집니다.

## 11. 바로 수정하기 좋은 항목

첫 번째 수정 작업으로는 인코딩 깨진 텍스트 복구와 OpenAI 키 노출 제거를 추천합니다.

추천 순서:

1. 모든 깨진 한국어 문구를 정상 문구로 교체
2. `app/api/analyze/route.ts` 생성
3. `TradingSignals.tsx`에서 OpenAI SDK import 제거
4. 클라이언트에서 `/api/analyze` 호출하도록 변경
5. 실패/로딩 메시지 정리
6. `pnpm build`로 확인

이 순서로 진행하면 사용자에게 보이는 문제와 보안상 가장 큰 문제를 먼저 줄일 수 있습니다.
