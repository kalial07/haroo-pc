'use strict';
/*
 * HAROO PC — (A) 실용형 오버레이 셸 (V1 마일스톤 1)
 * 데모(renderer/haroo-erp-v0.html)는 건드리지 않고,
 * 메인 프로세스에서 insertCSS / executeJavaScript 로 오버레이 적응만 주입한다.
 * (= 우리가 정한 규칙: 오버레이 수정은 main.js 경유)
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron');
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

let win = null;
let tray = null;

/* ---- 활성 디스플레이의 작업영역(작업표시줄 제외, DIP 좌표) ---- */
function activeWorkArea() {
  const pt = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay();
  return disp.workArea; // DPI 배율은 Electron이 DIP로 알아서 처리
}

/* ============================================================
 *  오버레이 적응 (데모 페이지에 주입)
 * ============================================================ */
const OVERLAY_CSS = `
  html, body { background: transparent !important; }
  /* 가짜 데스크톱 크롬 제거 → 진짜 바탕화면 위에 뜨도록 */
  #desktop, #taskbar, .v0badge, .deskhint, .floor { display: none !important; }
  /* 생활공간 디오라마를 실제 작업영역 바닥에 안착 */
  #scenery { bottom: 0 !important; }
`;

const OVERLAY_JS = `
(function () {
  // ── 1) 지면선: 실제 작업영역 바닥 기준으로 보정 (가짜 작업표시줄 오프셋 제거)
  //    발이 바닥에 닿는 느낌이 안 맞으면 이 값(GROUND_OFFSET)만 조절하세요.
  var GROUND_OFFSET = 70;
  window.groundY = function () { return innerHeight - GROUND_OFFSET; };
  try { if (window.pos) { pos.y = groundY(); if (typeof place === 'function') place(); } } catch (e) {}

  // ── 2) 클릭 통과: 캐릭터/런처/창/메뉴 위에서만 이벤트 수신, 나머지는 바탕화면으로 통과
  var interactive = false;
  function setInteractive(v) {
    if (v === interactive) return;
    interactive = v;
    if (window.haroo && window.haroo.setInteractive) window.haroo.setInteractive(v);
  }
  // 투명 배경(=body/html/#desktop) 위면 통과, 그 외 실제 UI 위면 수신.
  // 장식 레이어(#scenery/.floor 등)는 pointer-events:none 이라 elementFromPoint가 건너뜀 → 자동 통과.
  function interactiveAt(x, y) {
    var el = document.elementFromPoint(x, y);
    if (!el) return false;
    if (el === document.body || el === document.documentElement) return false;
    if (el.id === 'desktop') return false;
    return true;
  }
  window.addEventListener('mousemove', function (e) {
    setInteractive(interactiveAt(e.clientX, e.clientY));
  }, true);
  // 드래그 중에는 수신 유지
  document.addEventListener('pointerdown', function () { setInteractive(true); }, true);

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

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // 시작은 클릭 통과(forward:true 로 mousemove 는 계속 받아 hit-test 가능)
  win.setIgnoreMouseEvents(true, { forward: true });

  win.loadFile(RENDERER);

  win.webContents.on('did-finish-load', function () {
    win.webContents.insertCSS(OVERLAY_CSS);
    win.webContents.executeJavaScript(OVERLAY_JS).catch(function () {});
    win.showInactive(); // 포커스 가로채지 않고 표시
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
}

function sendToRenderer(cmd) {
  if (win && !win.isDestroyed() && win.webContents) win.webContents.send('haroo:tray', cmd);
}

/* ============================================================
 *  IPC
 * ============================================================ */
ipcMain.on('haroo:set-interactive', function (e, v) {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!v, { forward: true });
});
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
    { label: '캐릭터 보이기', click: function () { if (win) win.showInactive(); sendToRenderer('show'); } },
    { label: '캐릭터 숨기기', click: function () { sendToRenderer('hide'); } },
    { type: 'separator' },
    { label: '대시보드 열기', click: function () { if (win) win.showInactive(); sendToRenderer('dashboard'); } },
    { type: 'separator' },
    { label: '종료', click: function () { app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', function () { sendToRenderer('dashboard'); });
}

/* ============================================================
 *  생명주기
 * ============================================================ */
app.whenReady().then(function () {
  createWindow();
  buildTray();
});

// 오버레이 펫이라 창을 닫아도 트레이로 살아있게 유지
app.on('window-all-closed', function () {});
app.on('before-quit', function () { if (tray) { tray.destroy(); tray = null; } });
