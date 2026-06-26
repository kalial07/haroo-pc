'use strict';
/*
 * HAROO PC — (A) 실용형 오버레이 셸 (V1 마일스톤 1)
 * 데모(renderer/haroo-erp-v0.html)는 건드리지 않고,
 * 메인 프로세스에서 insertCSS / executeJavaScript 로 오버레이 적응만 주입한다.
 * (= 우리가 정한 규칙: 오버레이 수정은 main.js 경유)
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut } = require('electron');
const path = require('path');

// electron-store (창/캐릭터 위치만 저장 · 앱 데이터는 데모의 localStorage 유지)
let store;
try {
  const Store = require('electron-store');
  store = new Store({ name: 'haroo-window' });
} catch (e) {
  const mem = {};
  store = { get: (k, d) => (k in mem ? mem[k] : d), set: (k, v) => { mem[k] = v; } };
}

const RENDERER = path.join(__dirname, '..', 'renderer', 'haroo-erp-v0.html');
const CHAT = path.join(__dirname, '..', 'renderer', 'chat.html');

let win = null;
let tray = null;
let chatWin = null;               // 별도 채팅창

/* ============================================================
 *  레이어 상태머신
 *  - 평소: 바탕화면 레이어 (최상위 아님 · 완전 클릭 통과 · 다른 창에 가려짐)
 *  - 액션 타임: 최상위 · 드래그 가능 · 인터랙션 수신
 *  전환: 알림 / 단축키(Ctrl+Alt+H) → 액션,  10초 무반응 → 바탕화면
 * ============================================================ */
const IDLE_MS = 10000;            // 액션 타임 유지 시간(무반응 기준) — 조절 포인트
const HOTKEY = 'CommandOrControl+Alt+H';
const HOTKEY_FALLBACK = 'CommandOrControl+Shift+H';
let actionMode = false;           // 현재 액션 타임인가
let idleTimer = null;             // 10초 무반응 타이머
let pendingAlert = false;         // 풀스크린이라 보류된 알림
let chatOpen = false;             // 채팅창 열려있는 동안엔 하루가 안 잠듦

/* ---- 활성 디스플레이의 작업영역(작업표시줄 제외, DIP 좌표) ---- */
function activeWorkArea() {
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay();
  return disp.workArea; // DPI 배율은 Electron이 DIP로 알아서 처리
}

/* ---- 풀스크린 앱 추정 (네이티브 모듈 없이 휴리스틱) ----
 * 풀스크린 게임/영상/발표는 작업표시줄을 가린다 → 작업영역이 화면 전체와 같아짐.
 * 한계: '작업표시줄 자동 숨김'을 쓰는 사람은 평소에도 같아져 알림이 계속 보류됨.
 *       (정밀 감지는 Win32 GetForegroundWindow 네이티브 호출 필요 — 다음 마일스톤) */
function isLikelyFullscreen() {
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay();
  const wa = d.workArea, b = d.bounds;
  return wa.width === b.width && wa.height === b.height;
}

/* ---- 액션 타임 진입 ----
 * force=true (단축키/트레이/시작): 풀스크린이어도 무조건 올라옴 (사용자가 직접 부른 것)
 * force=false (알림 자동): 풀스크린이면 보류했다가 빠져나올 때 표시 */
function enterAction(reason, force) {
  if (!win || win.isDestroyed()) return;
  if (!force && isLikelyFullscreen()) { pendingAlert = true; return; }
  if (actionMode) { refreshIdle(); return; } // 이미 액션 중 → 타이머만 갱신
  actionMode = true;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true }); // hit-test 재개(캐릭터 위만 수신)
  win.showInactive();
  if (win.webContents) win.webContents.send('haroo:action-mode', true);
  refreshIdle();
}

/* ---- 바탕화면 레이어로 복귀 ---- */
function exitAction() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (chatOpen) return;                                // 채팅 중엔 안 가라앉음
  if (!win || win.isDestroyed()) { actionMode = false; return; }
  actionMode = false;
  win.setAlwaysOnTop(false);                         // 다른 창이 덮도록
  win.setIgnoreMouseEvents(true, { forward: true }); // 하지만 hit-test 는 유지(보이면 클릭 가능)
  if (win.webContents) win.webContents.send('haroo:action-mode', false);
}

/* ---- 무반응 타이머 갱신 (건드림/드래그/새 알림마다 호출) ---- */
function refreshIdle() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (chatOpen) return;                  // 채팅창 열려있는 동안엔 타이머 안 검
  idleTimer = setTimeout(exitAction, IDLE_MS);
}

/* ============================================================
 *  오버레이 적응 (데모 페이지에 주입)
 * ============================================================ */
const OVERLAY_CSS = `
  html, body { background: transparent !important; }
  /* 가짜 데스크톱 크롬만 제거 → 진짜 바탕화면 위에 하루 + 생활공간 */
  #desktop, #taskbar, .v0badge, .deskhint, .floor { display: none !important; }
  /* 생활공간(카페/오피스/집)을 실제 작업영역 바닥에 안착 (z-index 39 = 캐릭터 뒤) */
  #scenery { bottom: 0 !important; }
`;

const OVERLAY_JS = `
(function () {
  // ── 1) 지면선: 실제 작업영역 바닥 기준으로 보정 (가짜 작업표시줄 오프셋 제거)
  //    발이 바닥에 닿는 느낌이 안 맞으면 이 값(GROUND_OFFSET)만 조절하세요.
  var GROUND_OFFSET = 70;
  window.groundY = function () { return innerHeight - GROUND_OFFSET; };
  try { if (window.pos) { pos.y = groundY(); if (typeof place === 'function') place(); } } catch (e) {}

  // ── 2) 클릭 통과 + 레이어 상태
  //    hit-test 는 두 상태 모두에서 동작 → 하루가 화면에 '보일 때' 그 위 클릭이 잡힘.
  //    (가려져 있으면 그 자리는 위에 있는 창이 클릭을 가져가서 자동 통과 = "보일 때만")
  var actionMode = false;
  var interactive = false;
  var lastActivity = 0;
  function setInteractive(v) {
    if (v === interactive) return;
    interactive = v;
    if (window.haroo && window.haroo.setInteractive) window.haroo.setInteractive(v);
  }
  function activity() {            // 건드림 → 액션 타임 10초 타이머 갱신 (스로틀)
    var t = Date.now();
    if (t - lastActivity < 400) return;
    lastActivity = t;
    if (window.haroo && window.haroo.activity) window.haroo.activity();
  }
  function interactiveAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (el.id === 'desktop') return false;
    return true;
  }
  if (window.haroo && window.haroo.onActionMode) {
    window.haroo.onActionMode(function (on) { actionMode = on; });
  }
  // 커서가 하루 위에 오면 창을 잠깐 '실체화'(클릭 수신) → 클릭이 하루에 닿을 수 있게.
  // 빈 곳에선 통과 유지. 두 레이어 모두 동일.
  window.addEventListener('mousemove', function (e) {
    var over = interactiveAt(e.clientX, e.clientY);
    setInteractive(over);
    if (over && actionMode) activity(); // 액션 중일 때만 타이머 갱신
  }, true);
  // 하루를 누르면(=보이는 하루를 클릭) 깨우기. 이미 액션이면 타이머만 갱신.
  document.addEventListener('pointerdown', function () {
    setInteractive(true);
    if (window.haroo && window.haroo.wake) window.haroo.wake();
    if (actionMode) activity();
  }, true);
  // 하루 더블클릭 → 중앙 채팅창 열기 (대시보드 등 다른 UI 더블클릭은 무시)
  document.addEventListener('dblclick', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('#charLayer')) {
      if (window.haroo && window.haroo.openChat) window.haroo.openChat();
    }
  }, true);

  // ── 3) 위치 영속화: x는 작업영역 가로 비율로 저장, y는 항상 지면선
  if (window.haroo && window.haroo.loadPos) {
    window.haroo.loadPos().then(function (p) {
      try {
        if (p && typeof p.xFrac === 'number' && window.pos) {
          pos.x = Math.max(40, Math.min(innerWidth - 40, p.xFrac * innerWidth));
          pos.y = groundY();
          if (typeof place === 'function') place();
        }
      } catch (e) {}
    });
  }
  window.addEventListener('pointerup', function () {
    try {
      if (window.pos && window.haroo && window.haroo.savePos) {
        window.haroo.savePos({ xFrac: pos.x / innerWidth });
      }
    } catch (e) {}
  });

  // ── 4) 트레이 명령
  if (window.haroo && window.haroo.onTrayCommand) {
    window.haroo.onTrayCommand(function (cmd) {
      try {
        if (cmd === 'show' && typeof showChar === 'function') showChar();
        else if (cmd === 'hide' && typeof hideChar === 'function') hideChar();
        else if (cmd === 'dashboard') {
          if (typeof showChar === 'function') showChar();
          if (typeof openWin === 'function') openWin('dashboard');
          if (typeof gotoPage === 'function') gotoPage('overview');
        }
      } catch (e) {}
    });
  }

  // ── 5) 해상도/모니터 변경 시 재배치
  if (window.haroo && window.haroo.onReflow) {
    window.haroo.onReflow(function () {
      try {
        if (window.pos) {
          pos.x = Math.min(Math.max(40, pos.x), innerWidth - 40);
          pos.y = groundY();
          if (typeof place === 'function') place();
        }
      } catch (e) {}
    });
  }

  if (window.haroo && window.haroo.ready) window.haroo.ready();
})();
`;

/* ============================================================
 *  창
 * ============================================================ */
function createWindow() {
  const wa = activeWorkArea();
  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  // 시작 상태 = 바탕화면 레이어 (최상위 아님). hit-test 는 계속 동작(forward:true) →
  // 하루가 보이면 클릭으로 깨우고, 가려지면 위 창이 클릭을 가져가 자동 통과.
  win.setAlwaysOnTop(false);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(RENDERER);

  win.webContents.on('did-finish-load', function () {
    win.webContents.insertCSS(OVERLAY_CSS);
    win.webContents.executeJavaScript(OVERLAY_JS).catch(function () {});
    win.showInactive(); // 포커스 가로채지 않고 표시
    // 첫 구동 인사 겸 위치 잡기용 — 잠깐 액션 타임으로 떴다가 10초 뒤 바탕화면으로 가라앉음
    enterAction('startup', true);
  });

  screen.on('display-metrics-changed', reflow);
  screen.on('display-added', reflow);
  screen.on('display-removed', reflow);
}

function reflow() {
  if (!win || win.isDestroyed()) return;
  const wa = activeWorkArea();
  win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
  win.webContents.send('haroo:reflow');
  // 풀스크린 빠져나옴 → 보류했던 알림 표시
  if (pendingAlert && !isLikelyFullscreen()) {
    pendingAlert = false;
    enterAction('pending', false);
  }
}

function sendToRenderer(cmd) {
  if (win && !win.isDestroyed() && win.webContents) win.webContents.send('haroo:tray', cmd);
}

/* ============================================================
 *  IPC
 * ============================================================ */
ipcMain.on('haroo:set-interactive', function (e, v) {
  // 두 레이어 모두에서 동작: 커서가 하루 위면 창 실체화(클릭 수신), 아니면 통과
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!v, { forward: true });
});
// 보이는 하루를 클릭 → 액션 타임으로 깨우기 (이미 액션이면 타이머 갱신)
ipcMain.on('haroo:wake', function () { enterAction('click', true); });
// 건드림/드래그 보고 → 10초 타이머 갱신
ipcMain.on('haroo:activity', function () { if (actionMode) refreshIdle(); });
// 알림 발생 시 액션 타임으로 깨우기 (미래 AI 알림 연결점 · 풀스크린이면 자동 보류)
ipcMain.on('haroo:alert', function () { enterAction('alert', false); });

/* ---- 더블클릭 → 중앙 채팅창 (별도 창 · 현재 목 UI) ----
 * 채팅창이 떠 있는 동안 하루는 액션 타임 유지(가라앉지 않음). */
function openChat() {
  enterAction('chat', true); // 하루를 보이는 상태로
  if (chatWin && !chatWin.isDestroyed()) { chatWin.show(); chatWin.focus(); return; }
  const pt = screen.getCursorScreenPoint();
  const d = screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay();
  const wa = d.workArea, W = 400, H = 600;
  chatWin = new BrowserWindow({
    x: Math.round(wa.x + (wa.width - W) / 2),
    y: Math.round(wa.y + (wa.height - H) / 2),
    width: W, height: H, minWidth: 340, minHeight: 460,
    frame: false, transparent: true, backgroundColor: '#00000000',
    resizable: true, movable: true, hasShadow: true, fullscreenable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  chatWin.loadFile(CHAT);
  chatWin.once('ready-to-show', function () { chatWin.show(); chatWin.focus(); });
  chatOpen = true;
  refreshIdle(); // chatOpen=true 라 타이머 해제 → 안 가라앉음
  chatWin.on('closed', function () {
    chatWin = null; chatOpen = false;
    refreshIdle(); // 닫히면 10초 카운트 재개
  });
}
ipcMain.on('haroo:open-chat', function () { openChat(); });
ipcMain.on('haroo:save-pos', function (e, p) {
  store.set('charXFrac', (p && typeof p.xFrac === 'number') ? p.xFrac : 0.5);
});
ipcMain.handle('haroo:load-pos', function () {
  return { xFrac: store.get('charXFrac', 0.5) };
});
ipcMain.on('haroo:ready', function () { /* 렌더러 준비 완료 (확장용) */ });

/* ============================================================
 *  트레이 (보조 진입점 · 숨김 복귀 · 종료)
 * ============================================================ */
function buildTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, '..', 'resources', 'tray.png'));
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('HAROO');
  const menu = Menu.buildFromTemplate([
    { label: '하루 부르기  (Ctrl+Alt+H)', click: function () { if (win) win.showInactive(); enterAction('tray', true); } },
    { type: 'separator' },
    { label: '캐릭터 보이기', click: function () { if (win) win.showInactive(); sendToRenderer('show'); } },
    { label: '캐릭터 숨기기', click: function () { sendToRenderer('hide'); } },
    { type: 'separator' },
    { label: '대시보드 열기', click: function () { if (win) win.showInactive(); enterAction('tray', true); sendToRenderer('dashboard'); } },
    { type: 'separator' },
    { label: '종료', click: function () { app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', function () { if (win) win.showInactive(); enterAction('tray', true); sendToRenderer('dashboard'); });
}

/* ============================================================
 *  생명주기
 * ============================================================ */
app.whenReady().then(function () {
  createWindow();
  buildTray();
  // 전역 단축키: 어디서든 하루를 액션 타임으로 부름
  let ok = globalShortcut.register(HOTKEY, function () { if (win) win.showInactive(); enterAction('hotkey', true); });
  if (!ok) { // 다른 앱이 Ctrl+Alt+H 를 이미 쓰면 대체키 시도
    ok = globalShortcut.register(HOTKEY_FALLBACK, function () { if (win) win.showInactive(); enterAction('hotkey', true); });
  }
});

// 오버레이 펫이라 창을 닫아도 트레이로 살아있게 유지
app.on('window-all-closed', function () {});
app.on('before-quit', function () {
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
});
