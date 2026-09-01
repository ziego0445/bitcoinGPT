# ICT 전략

`scripts/lib/ict-signals.js` / `app/components/IctStrategyChart.tsx` / `scripts/paper-trade-ict.js`
기준 정리. 이 문서와 코드가 어긋나면 코드가 맞습니다.

## 상태 (지금 여기까지 왔음)

- **150일/15분봉 백테스트 완료** (승률/R배수/MSS·BOS/LONG·SHORT 비교, in-sample·
  out-of-sample 분리 검증 — 아래 "백테스트 결과" 참고).
- **$100 모의투자로 검증 완료, 이제 실거래 전환.** `scripts/paper-trade-ict.js`
  (GitHub Actions cron)는 은퇴시키고, `scripts/live-trade-ict.js`가 사용자 PC에서
  double-bottom 봇(`scripts/live-trade.js`)과 나란히 상시 실행되며 **실제 OKX 계좌**로
  주문을 냄. `data/paper-trades-ict.json`은 기록으로만 남고 더 이상 갱신 안 됨.
- **계좌 분리 문제는 별도 거래소(OKX)로 해결.** Bitget은 원웨이 모드라 두 봇이 같은
  계좌·심볼을 쓰면 포지션이 합쳐지는 문제가 있었음 — double-bottom은 Bitget에 그대로
  두고, ICT는 완전히 별도 계좌인 OKX로 옮겨서 $ 독립 운용을 달성함.
- LONG/SHORT 둘 다 신호는 내지만, 백테스트 결과 **실거래도 LONG만** 사용 (아래 참고).

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

## 실거래 구조 (완료)

**계좌 분리는 OKX로 해결됨.** double-bottom(Bitget)과 ICT(OKX)는 서로 다른 거래소·다른
계좌라 포지션이 절대 섞이지 않음. 별도 계정 발급이나 심볼 구분 없이 가장 단순하게
$ 독립 운용을 달성.

**실제 구성**:
1. `scripts/lib/okx-client.js` — OKX v5 REST 클라이언트(`scripts/lib/bitget-client.js`와
   같은 형태). HMAC-SHA256 서명(`OK-ACCESS-*` 헤더), 캔들/잔고/포지션 조회, 주문 실행,
   레버리지 설정. 이 계좌는 헤지 모드(`posMode: long_short_mode`)라 모든 호출에
   `posSide: "long"`을 명시 — 이 봇은 LONG만 거래하므로 그 외 값은 안 씀.
2. `scripts/live-trade-ict.js` — `scripts/live-trade.js`를 뼈대로 복사, 신호 소스만
   `detectICTSignals()`(LONG 필터)로 교체. `stopLoss = signal.sweepPrice`,
   `takeProfit = entryPrice + (entryPrice - sweepPrice) * 2`(R=2) — double-bottom의 고정
   ±8%와 달리 **매 신호마다 폭이 다른** 구조적 손절. `CANDLE_GRANULARITY = "15m"`,
   증거금은 **고정 금액**(`OKX_MARGIN_USDT` 환경변수, 비우면 가용잔고의 95%) — double-bottom과
   잔고를 두고 잠식하지 않도록 분리.
3. TP/SL은 OKX의 `attachAlgoOrds`(진입 주문에 `tpTriggerPx`/`slTriggerPx` 첨부)로
   거래소단에서 관리 — Bitget의 `presetStopSurplusPrice`/`presetStopLossPrice`와 동일한
   역할. 이 프로세스가 꺼져 있어도 거래소가 청산을 보장함.
4. 상태 파일은 `data/live-trades-ict.json`(double-bottom의 `data/live-trades.json`과
   분리), 대시보드는 이 파일이 있으면 `data/paper-trades-ict.json` 대신 이걸 우선
   표시함(`IctStrategyChart.tsx`의 `liveState ?? rawPaperState`).
5. 실행: `run-live-trade-ict.bat` (더블클릭 또는 cmd에서 실행). double-bottom 봇은
   기존대로 `run-live-trade.bat`. 둘 다 PC가 켜져 있는 동안 상시 실행되는 별도
   프로세스 — 창을 닫으면 그 봇만 멈춤.

**미검증 항목 (실거래 첫 청산 때 확인 필요)**: OKX 주문내역(`orders-history`)에서
청산 주문을 골라내는 필드 이름(`side`/`reduceOnly`/`avgPx`)은 문서 기준 추정치이고
아직 실제 체결로 검증 전임 — `reconcilePosition()`의 주석 참고. 틀려도 실제 TP/SL
집행(거래소단 attachAlgoOrds)에는 영향 없고, 거래 기록에 붙는 라벨(익절/손절 표시)만
잠깐 부정확할 수 있음 — 잔고 변화로 대체 추정하는 fallback이 이미 있음.

## 그 외 다음에 해볼 만한 것 (우선순위 낮음)

1. `SWING_STRENGTH` / `SWEEP_LOOKBACK` / `MSS_MAX_GAP` / `fvgMinWidthATR` 파라미터 스윕
   — 지금 값들은 첫 추정치, 아직 최적화 안 함.
2. (선택) 킬존 — 런던/뉴욕 특정 시간대에만 진입 허용하는 시간 필터. tradeforopp의
   "ICT Killzones & Pivots"(MPL 2.0)에서 확인한 별개의 ICT 개념. LuxAlgo "ICT Killzones
   Toolkit"은 아예 킬존 밖에서는 구조 추적 자체를 리셋함(`if not inKZ: shift := 0`) —
   더 강한 버전.
3. 하락장/횡보장 구간 데이터로 재검증 (지금 150일은 상승장 위주 — 위 "주의" 참고).
