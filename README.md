# HAROO PC — 실용형 오버레이 셸 (V1 · 마일스톤 1)

V0 데모(`renderer/haroo-erp-v0.html`)를 **건드리지 않고** 투명 오버레이로 감싼 Electron 앱이다.
오버레이 적응(투명화·가짜 데스크톱 제거·지면선 보정·클릭 통과·위치 영속화)은 전부
메인 프로세스에서 `insertCSS` / `executeJavaScript` 로 주입한다 → 데모는 계속 따로 수정/교체 가능.

## 실행 — 더블클릭만 (파워셸 필요 없음)
0. **Node.js 설치(한 번만)**: https://nodejs.org 에서 LTS 설치.
1. **`1. 최초 설치.bat`** 더블클릭 — 의존성 다운로드(처음 한 번, 1~2분).
2. **`2. 하루 실행.vbs`** 더블클릭 — 바탕화면에 하루 등장. (콘솔 창 안 뜸)

> 빈 곳 클릭은 바탕화면으로 통과, 하루 드래그→놓으면 천천히 착지.
> 우하단 트레이 아이콘 → 보이기/숨기기/대시보드/종료.

## .exe 설치본 만들기 (선택)
- **`3. (선택) 설치본 만들기.bat`** 더블클릭 → `dist/` 에 NSIS 설치본 + Portable .exe 생성.
- 서명 안 함 → 첫 실행 시 SmartScreen 경고("Windows가 PC를 보호했습니다") 뜰 수 있음. "추가 정보 → 실행"으로 진행. 정식 배포 시 코드서명 인증서 도입.
- 빌드는 **Windows에서** 권장.

> 개발자용(터미널): `npm install` → `npm run dev` / 빌드 `npm run dist`

## 이번 마일스톤에서 되는 것
- ✅ 투명 · 프레임리스 · always-on-top 오버레이 (작업영역 = 실제 작업표시줄 제외 영역)
- ✅ 진짜 바탕화면 위에 캐릭터/생활공간/POD 런처가 뜸 (가짜 배경·작업표시줄 제거)
- ✅ **클릭 통과**: 캐릭터/런처/창/메뉴 위에서만 클릭 수신, 나머지는 바탕화면으로 통과 (`setIgnoreMouseEvents(true,{forward:true})` + hit-test)
- ✅ **지면선 보행 + 드래그 + 놓으면 1.5초 낙하산 착지** (데모 로직 그대로 재사용)
- ✅ **위치 영속화 + 보정**: 캐릭터 x를 작업영역 가로 비율로 `electron-store`에 저장, 재시작/모니터·해상도 변경 시 현재 작업영역으로 복원·클램프 (DPI 배율은 Electron DIP 좌표로 자동 처리, 멀티모니터는 커서 있는 디스플레이 기준)
- ✅ **트레이**: 보이기 / 숨기기 / 대시보드 / 종료
- ✅ 우클릭 캐릭터 메뉴(데모 기본)

## 아직 안 된 것 (다음 마일스톤)
- ⏳ **풀스크린 앱 위 자동 숨김** (게임·발표 가림 방지) — 포그라운드 풀스크린 감지는 OS별로 별도 구현 필요. 지금은 미구현.
- ⏳ 폰트가 CDN(Jua/Pretendard)이라 **오프라인이면 시스템 폰트로 대체** → 폰트 로컬 번들 예정.
- ⏳ 앱 데이터(태스크·캐릭터)는 데모의 `localStorage` 유지(Electron에서 정상 영속). 추후 `electron-store`로 이전.
- ⏳ 실제 AI/파츠 생성/OCR은 데모 그대로 목(mock). 어댑터 seam에 연결 예정.
- ⏳ 캐릭터 창 / 대시보드 창 **분리(B 사양서형)** 는 추후 리팩터링.

## 위치/지면 미세조정
- 발이 바닥에 안 맞으면: `src/main.js` 의 `OVERLAY_JS` 안 **`GROUND_OFFSET`**(기본 70) 값만 조절.
- 기본 시작 위치 비율: `src/main.js` `haroo:load-pos` 의 기본값 `0.5`.

## 구조
```
haroo-pc/
├── package.json          # electron / electron-store / electron-builder
├── src/
│   ├── main.js           # 오버레이 창 · 클릭통과 · 위치저장(DPI/멀티모니터) · 트레이 · 주입
│   └── preload.js        # contextBridge: window.haroo (IPC 브리지)
├── renderer/
│   └── haroo-erp-v0.html # V0 데모(원본 그대로) = 렌더러
└── resources/            # tray.png / icon.ico / icon.png
```
