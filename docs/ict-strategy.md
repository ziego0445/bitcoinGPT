# ICT 전략

`scripts/lib/ict-signals.js` / `app/components/IctStrategyChart.tsx` / `scripts/paper-trade-ict.js`
기준 정리. 이 문서와 코드가 어긋나면 코드가 맞습니다.

## 상태 (지금 여기까지 왔음)

- **150일/15분봉 백테스트 완료** (승률/R배수/MSS·BOS/LONG·SHORT 비교, in-sample·
  out-of-sample 분리 검증 — 아래 "백테스트 결과" 참고).
- **$100 모의투자 진행 중.** `scripts/paper-trade-ict.js`가 GitHub Actions에서 5분마다
  실행되며 `data/paper-trades-ict.json`에 기록, "ICT 전략" 탭에서 실시간 확인 가능.
  실제 Bitget 계좌·`scripts/live-trade.js`와는 완전히 분리된 가상 시뮬레이션.
- **실거래(`scripts/live-trade.js`)엔 아직 연결 안 됨.** 지금 실거래는 여전히
  `scripts/lib/signals.js`의 double-bottom 패턴만 씀. 모의투자 결과가 좋으면 실거래
  전환을 검토하기로 함 — 아래 "실거래 전환 체크리스트" 참고.
- LONG/SHORT 둘 다 신호는 내지만, 백테스트 결과 **모의투자는 LONG만** 사용 (아래 참고).

## 백테스트 결과 (150일/15분봉, in/out-of-sample 분리)

R=2(목표=손절폭의 2배), 스톱은 스윕 극값 기준. 계좌 100 시작:

| 조건 | 전체 | in-sample | out-of-sample |
|---|---|---|---|
| 양방향, 필터 없음 | 46.69 | 89.27 | 44.79 |
| MSS만 (반전형) | 10.09 | 29.90 | 28.89 |
| BOS만 (추세연속형) | 175.95 | 182.42 | 96.45 |
| **LONG만** | **236.91** | **157.28** | **150.63** |
| SHORT만 | 29.24 | 63.24 | 39.59 |

- **LONG만 했을 때 R=1.5~4 전체 구간에서 in/out 양쪽 다 일관되게 수익** — 이 대화에서
  나온 것 중 가장 견고한 패턴. R=2 기준 승률 44.3%(97건)지만 목표가 손절의 2배라
  기대값은 +0.33R/건으로 정상.
- **주의**: 이 150일이 BTC가 6.4만→7.8만까지 오른 상승장 구간이었음 — "롱이 원래
  낫다"보다는 "이 기간엔 눌림목 매수가 잘 먹혔다"에 가까울 수 있음. 하락장/횡보장
  데이터로 재검증 전까지는 방향성 엣지로 단정하지 말 것.
- LONG+BOS를 동시에 필터링하면 표본이 너무 줄어(n≈20) 오히려 애매해짐 — LONG 단독
  필터가 이미 충분하고, 굳이 MSS/BOS로 더 좁힐 필요 없음이 확인됨.

## 참고한 개념 (LuxAlgo 공개 인디케이터의 용어를 그대로 재구현한 것 — Pine 소스를 그대로
포팅한 게 아니라 독립적으로 다시 짠 것)

- **ICT Concepts**: Liquidity Sweep → MSS → FVG 진입 시퀀스의 원출처.
- **Smart Money Concepts**: 구조(Structure)/BOS/CHoCH 용어 참고용.

## 로직 (3단계)

1. **Liquidity Sweep (유동성 스윕)**: 최근 스윙 저점(고점) 아래(위)로 꼬리만 뚫고 종가는
   다시 그 레벨 위(아래)로 마감 — 스탑헌팅 후 반전 신호. 스윙 포인트는 좌우 2봉 프랙탈로
   정의 (`getSwingPoints`, `SWING_STRENGTH=2`).
2. **MSS (Market Structure Shift)**: 스윕 이후 최대 `MSS_MAX_GAP`(15)봉 안에 그 반대편
   최근 스윙 포인트를 종가로 돌파 — 구조 전환 확인. `computeStructureBreaks()`가 전체
   캔들을 한 번 순회하며 추세 상태(`trend`)를 추적해서, **그 방향으로의 첫 돌파는 MSS
   (=CHoCH, 추세 반전급), 이미 같은 방향이면 BOS(=추세 연속)**로 구분해 각 신호에
   `mssType`로 표시함 — LuxAlgo "ICT Concepts" 원본의 `MSS.dir` 상태머신과 동일한 방식
   (실제 Pine 소스로 확인). 필터링은 안 하고 노출만 함 — MSS만/BOS만/둘 다 중 뭐가
   더 잘 되는지는 백테스트로 정할 문제라서.
3. **FVG (Fair Value Gap)**: 스윕~MSS 사이 임펄스 구간에서 3봉 갭(`i-2`와 `i` 캔들이 안
   겹치는 구간)을 찾고, 이후 캔들이 그 갭 안으로 다시 들어오는 순간을 진입 트리거로 봄.
   같은 셋업이 여러 봉에 걸쳐 반복 터치되는 건 최초 1회만 신호로 인정(`firedSetups`).
   LuxAlgo "ICT Killzones Toolkit" 원본의 실제 FVG 로직(`pFVG()`)과 대조해서 2가지 조건을
   추가함: **디스플레이스먼트**(가운데 임펄스 캔들의 종가가 갭 경계를 실제로 넘어서야
   함 — 항상 적용, 실데이터로 검증해보니 신호 수 변화 없이 정의만 더 정확해짐) 및
   **최소 갭 폭**(ATR(14) 대비 배수 필터, `fvgMinWidthATR` 옵션 — 원본 기본값 `1.2×ATR(144)`
   를 그대로 15분봉에 적용하면 신호가 0개로 죽어서, 기본값은 꺼둠(0) 두고 백테스트로
   나중에 정하기로 함).

무효화 조건: MSS 확정 이후 가격이 FVG를 터치하기 전에 스윕의 극값(저점/고점)을 다시
깨면 그 셋업은 폐기.

## 검증 이력

실제 오픈소스 참고해가며 총 3차례 검토, 버그 3개 발견·수정함:
1. **선행편향**: 스윙 포인트는 확정까지 `strength`봉이 더 필요한데, 그 전인데도 이미
   안다고 취급하던 버그 → `confirmedBy()`로 수정.
2. **MSS 방향 반대**: 스윕 "이후"에 새로 생긴 자잘한 고점/저점을 구조 레벨로 잘못 참조
   하고 있었음(실데이터로 확인: sweepIndex=115일 때 index 117/121을 썼는데, 실제로는
   스윕 이전의 진짜 구조 고점인 index 111이 맞음) → 스윕 "이전" 확정된 스윙으로 수정.
3. **MSS/BOS 분류와 실제 참조 레벨이 서로 다른 걸 보고 있었음**: BOS/CHoCH 구분을
   넣으면서 `findStructureBreak()`(스윕 시점 기준 스윙 참조)와 `computeStructureBreaks()`
   (매 캔들마다 계속 갱신되는 스윙 참조)를 따로 두고, 후자에서 타입만 인덱스로 찾아
   붙였는데 — 두 함수가 서로 다른 스윙 레벨을 참조하는 경우가 실데이터 신호의
   **54%(35개 중 19개)** 에서 발생, `mssType`이 틀리거나 기본값(MSS)으로 얼버무려지고
   있었음 → 구조 판정을 `computeStructureBreaks()` 하나로 통일하고
   `findStructureBreak()`는 제거. 재검증 결과 불일치 0건.

이후 KanekiCraynet/Price-Action-Concepts(MIT)와 LuxAlgo "ICT Concepts" 원본(CC BY-NC-SA
4.0, 실제 Pine 소스 확인)을 참고해서 BOS/CHoCH 구분을 반영함. **다만 LuxAlgo 원본에도
"스윕→MSS→FVG"를 하나로 묶은 진입 신호 로직 자체는 없음** — 구조/유동성/FVG를 각각
따로 그려줄 뿐, 조합은 트레이더 재량. 이 조합 로직(3단계를 하나의 신호로 묶는 것)은
독자적으로 설계한 부분이라 백테스트로 직접 검증하는 것 외엔 확인할 방법이 없음.

## 실거래 전환 체크리스트 (모의투자 성과 보고 결정)

**막혀있는 결정 하나**: double-bottom 봇과 **같은 Bitget 계좌·같은 심볼(BTCUSDT)** 을
그대로 쓰면, 계좌가 원웨이(one-way) 모드라 두 봇의 포지션이 하나로 합쳐져 버려서
"이 봇은 $300, 이 봇은 $70" 식의 독립 운용이 안 됨. 실거래 전환 전에 아래 중 하나를
먼저 정해야 함:
- **Bitget 하위계정/별도 계정 발급** (추천 — 완전히 물리적으로 분리됨)
- **다른 심볼로 구분** (예: ETHUSDT — 단, 지금 검증은 전부 BTC 데이터라 그 심볼로
  다시 백테스트 필요)
- 위 둘 다 싫으면 포지션 통합(단일 봇, 신호 우선순위만 결정) — $ 분리 운용 포기

**계정 문제가 정리되면, `scripts/live-trade-ict.js` 만들 때 이렇게 하면 됨** (지금
`scripts/paper-trade-ict.js`가 정확히 이 로직으로 이미 검증된 상태라 포팅만 하면 됨):
1. `scripts/live-trade.js`를 뼈대로 복사 — Bitget 계좌 연동/재시작 복구/git 커밋 구조는
   이미 다 만들어져 있음, 진입 조건 부분만 갈아끼우면 됨.
2. 신호 소스를 `scripts/lib/signals.js`의 `detectSignals()` 대신
   `scripts/lib/ict-signals.js`의 `detectICTSignals()`로 교체, **`direction === "LONG"`만
   필터**(SHORT 배제 — 백테스트 근거, 위 참고).
3. `presetStopLossPrice` = `signal.sweepPrice`, `presetStopSurplusPrice` =
   `entryPrice + (entryPrice - sweepPrice) * 2` (R=2). 지금 double-bottom처럼 고정
   ±8%가 아니라 **매 신호마다 다른 폭**이 되는 게 정상 — 스윕 극값 기준 구조적 손절.
4. `CANDLE_GRANULARITY = "15m"` 그대로 (백테스트·모의투자 다 15분봉 기준).
5. 증거금은 이번에 논의한 대로 **고정 금액**(`BITGET_MARGIN_USDT` 환경변수)으로 —
   지금 double-bottom처럼 "가용잔고의 95%"로 두면 두 전략이 잔고를 두고 서로 잠식함.
6. 상태 파일은 `data/live-trades-ict.json`처럼 double-bottom과 다른 이름으로 분리,
   대시보드 폴링 URL(`PAPER_TRADE_ICT_URL` 자리)도 그에 맞게 교체.

**전환 전 최소 확인 사항**: 모의투자가 최소 며칠~몇 주치는 쌓여서 실제 라이브 데이터로도
백테스트랑 비슷한 방향(양전, 롱 우세)이 나오는지 먼저 봐야 함 — 150일 백테스트 하나만
믿고 바로 실거래로 가는 건 과최적화 위험 있음 (이 대화에서 double-bottom 튜닝할 때도
in-sample만 좋고 out-of-sample에서 뒤집힌 사례가 여러 번 있었음).

## 그 외 다음에 해볼 만한 것 (우선순위 낮음)

1. `SWING_STRENGTH` / `SWEEP_LOOKBACK` / `MSS_MAX_GAP` / `fvgMinWidthATR` 파라미터 스윕
   — 지금 값들은 첫 추정치, 아직 최적화 안 함.
2. (선택) 킬존 — 런던/뉴욕 특정 시간대에만 진입 허용하는 시간 필터. tradeforopp의
   "ICT Killzones & Pivots"(MPL 2.0)에서 확인한 별개의 ICT 개념. LuxAlgo "ICT Killzones
   Toolkit"은 아예 킬존 밖에서는 구조 추적 자체를 리셋함(`if not inKZ: shift := 0`) —
   더 강한 버전.
3. 하락장/횡보장 구간 데이터로 재검증 (지금 150일은 상승장 위주 — 위 "주의" 참고).
