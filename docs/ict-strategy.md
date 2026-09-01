# ICT 전략 (실험적, 미검증)

`scripts/lib/ict-signals.js` / `app/components/IctStrategyChart.tsx` 기준 정리. 이 문서와
코드가 어긋나면 코드가 맞습니다.

## 상태

- **백테스트 안 함.** 파라미터(스윙 강도, 룩백 범위)는 첫 추정치일 뿐 아무것도 검증 안 됨.
- **실거래(`scripts/live-trade.js`)에 연결 안 됨.** 지금 실거래는 여전히 `scripts/lib/signals.js`의
  double-bottom 패턴만 씀. 이 전략은 대시보드 상단 "ICT 전략" 탭에서 **참고용으로 보기만**
  가능함.
- LONG/SHORT 둘 다 신호는 내는데, 실거래 봇은 현재 **단일 포지션·LONG 전용** 구조라
  SHORT을 실제로 걸려면 `live-trade.js`를 먼저 고쳐야 함 (별도 작업).

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

## 다음에 할 일 (제안)

1. 이 저장소에 이미 있는 150일/15분봉 백테스트 하네스 패턴으로 실제 성과 검증
   (승률/기대값/최대 드로다운, MSS-only vs BOS-only vs 둘 다, `fvgMinWidthATR` 값별
   비교 포함) — double-bottom 때 했던 것과 동일한 방식.
2. `SWING_STRENGTH` / `SWEEP_LOOKBACK` / `MSS_MAX_GAP` / `fvgMinWidthATR` 파라미터 스윕.
3. (선택) 킬존 — 런던/뉴욕 특정 시간대에만 진입 허용하는 시간 필터. tradeforopp의
   "ICT Killzones & Pivots"(MPL 2.0)에서 확인한 별개의 ICT 개념. LuxAlgo "ICT Killzones
   Toolkit"은 아예 킬존 밖에서는 구조 추적 자체를 리셋함(`if not inKZ: shift := 0`) —
   더 강한 버전.
4. 검증되면 SHORT 지원 + 멀티 전략 동시 운용을 위해 `scripts/live-trade.js` 구조 변경 논의.
