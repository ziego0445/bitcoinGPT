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
   최근 스윙 포인트를 종가로 돌파 — 구조 전환 확인. BOS/CHoCH 구분은 아직 안 함(추세
   방향 추적 로직 없음 — 향후 개선 여지).
3. **FVG (Fair Value Gap)**: 스윕~MSS 사이 임펄스 구간에서 3봉 갭(`i-2`와 `i` 캔들이 안
   겹치는 구간)을 찾고, 이후 캔들이 그 갭 안으로 다시 들어오는 순간을 진입 트리거로 봄.
   같은 셋업이 여러 봉에 걸쳐 반복 터치되는 건 최초 1회만 신호로 인정(`firedSetups`).

무효화 조건: MSS 확정 이후 가격이 FVG를 터치하기 전에 스윕의 극값(저점/고점)을 다시
깨면 그 셋업은 폐기.

## 다음에 할 일 (제안)

1. 이 저장소에 이미 있는 150일/15분봉 백테스트 하네스 패턴으로 실제 성과 검증
   (승률/기대값/최대 드로다운) — double-bottom 때 했던 것과 동일한 방식.
2. `SWING_STRENGTH` / `SWEEP_LOOKBACK` / `MSS_MAX_GAP` 파라미터 스윕.
3. BOS vs CHoCH 구분 추가 (추세 상태 추적) — ICT에서는 CHoCH가 더 강한 신호로 취급됨.
4. 검증되면 SHORT 지원 + 멀티 전략 동시 운용을 위해 `scripts/live-trade.js` 구조 변경 논의.
