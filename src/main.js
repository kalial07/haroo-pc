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

// API 키 전용 스토어 (가벼운 암호화, 이 PC에만) + IPC
let secrets;
try {
  const Store = require('electron-store');
  secrets = new Store({ name: 'haroo-secrets', encryptionKey: 'haroo-local-v1' });
} catch (e) {
  const m2 = {};
  secrets = { get: (k, d) => (k in m2 ? m2[k] : d), set: (k, v) => { m2[k] = v; }, delete: (k) => { delete m2[k]; } };
}
function keyStatus() {
  return { claude: !!secrets.get('key.claude'), openai: !!secrets.get('key.openai') };
}

/* ---- 실제 API 호출 (메인이 키 들고 직접 호출 · CORS 없음) ---- */
const https = require('https');
const MODEL_CLAUDE = 'claude-haiku-4-5'; // 모델 안 맞으면 이 줄만 바꾸면 됨
const MODEL_OPENAI = 'gpt-4o-mini';      // 모델 안 맞으면 이 줄만 바꾸면 됨
const TONE = {
  '다정': '다정하고 따뜻한 말투로',
  '시크': '시크하고 간결한 말투로',
  '발랄': '발랄하고 톡톡 튀는 말투로',
  '차분': '차분하고 진중한 말투로',
  '츤데레': '새침하지만 속으론 챙겨주는 츤데레 말투로',
  '프로': '전문적이고 비서처럼 깔끔한 말투로'
};
function buildSystem() {
  const p = store.get('persona') || {};
  const name = p.name || '하루';
  const role = p.role || '나의 업무 비서';
  const tone = TONE[p.personality] || (p.personality ? (p.personality + ' 말투로') : '친근한 말투로');
  var lang = store.get('lang') || 'en';
  var langLine = (lang === 'en') ? ' Always reply in English.' : ' 한국어로 대답하세요.';
  return '당신은 "' + name + '"라는 이름의 데스크톱 업무 비서 캐릭터입니다. 맡은 역할은 "' + role + '"입니다. ' + tone + ' 간결하게 대답합니다. 사용자의 업무·일정·아이디어 정리를 돕고, 모호하면 먼저 짧게 확인 질문을 합니다. 너무 길게 말하지 않습니다.' + langLine;
}

function httpsJson(host, pathName, headers, bodyObj) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify(bodyObj);
    const req = https.request({
      method: 'POST', host: host, path: pathName,
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, headers)
    }, function (res) {
      let buf = '';
      res.on('data', function (d) { buf += d; });
      res.on('end', function () {
        let json = null; try { json = JSON.parse(buf); } catch (e) {}
        resolve({ status: res.statusCode, json: json, raw: buf });
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
async function callClaude(key, messages) {
  const r = await httpsJson('api.anthropic.com', '/v1/messages',
    { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    { model: MODEL_CLAUDE, max_tokens: 1024, system: buildSystem(), messages: messages });
  if (r.status === 200 && r.json && r.json.content) {
    return { ok: true, text: r.json.content.map(function (b) { return b.text || ''; }).join('') };
  }
  return { ok: false, error: (r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status) };
}
async function callOpenAI(key, messages) {
  const msgs = [{ role: 'system', content: buildSystem() }].concat(messages);
  const r = await httpsJson('api.openai.com', '/v1/chat/completions',
    { 'authorization': 'Bearer ' + key },
    { model: MODEL_OPENAI, messages: msgs });
  if (r.status === 200 && r.json && r.json.choices && r.json.choices[0]) {
    return { ok: true, text: r.json.choices[0].message.content };
  }
  return { ok: false, error: (r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status) };
}
function activeProvider() {
  const st = keyStatus();
  let a = secrets.get('active');
  if (a !== 'claude' && a !== 'openai') a = st.claude ? 'claude' : (st.openai ? 'openai' : null);
  if (a && !secrets.get('key.' + a)) a = st.claude ? 'claude' : (st.openai ? 'openai' : null);
  return a;
}
ipcMain.on('haroo:set-active-ai', function (e, info) {
  if (info && (info.provider === 'claude' || info.provider === 'openai')) secrets.set('active', info.provider);
});
ipcMain.on('haroo:set-persona', function (e, p) { if (p) store.set('persona', p); });
const MODEL_IMAGE = 'gpt-image-1'; // 인형 이미지 생성 모델
function multipartBody(fields, file) {
  const boundary = '----haroo' + Date.now().toString(16);
  const parts = [];
  Object.keys(fields).forEach(function (k) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n'));
  });
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + file.name + '"; filename="' + file.filename + '"\r\nContent-Type: ' + file.contentType + '\r\n\r\n'));
  parts.push(file.buffer);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  return { boundary: boundary, body: Buffer.concat(parts) };
}
function genDoll(key, imageB64, prompt) {
  const buf = Buffer.from(imageB64, 'base64');
  const full = '참고 이미지를 귀엽고 단순한 치비 마스코트 인형(봉제인형)으로 바꿔줘. 전신, 정면, 가운데 정렬, 동글동글한 형태, 부드러운 파스텔 색, 깔끔하고 굵은 외곽선, 플랫한 스타일, 단색 흰색 배경(나중에 제거함), 인형 주위에 충분한 여백을 두고 화면 가장자리에 닿지 않게, 글자 없음. ' + (prompt || '');
  const mp = multipartBody(
    { model: MODEL_IMAGE, prompt: full, size: '1024x1024', background: 'transparent', output_format: 'png', quality: 'low', n: '1' },
    { name: 'image', filename: 'ref.png', contentType: 'image/png', buffer: buf }
  );
  return new Promise(function (resolve) {
    const req = https.request({
      method: 'POST', host: 'api.openai.com', path: '/v1/images/edits',
      headers: { 'authorization': 'Bearer ' + key, 'content-type': 'multipart/form-data; boundary=' + mp.boundary, 'content-length': mp.body.length }
    }, function (res) {
      let b = '';
      res.on('data', function (d) { b += d; });
      res.on('end', function () {
        let j = null; try { j = JSON.parse(b); } catch (e) {}
        if (res.statusCode === 200 && j && j.data && j.data[0] && j.data[0].b64_json) resolve({ ok: true, b64: j.data[0].b64_json });
        else resolve({ ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + res.statusCode) });
      });
    });
    req.on('error', function (e) { resolve({ ok: false, error: String((e && e.message) || e) }); });
    req.write(mp.body); req.end();
  });
}
ipcMain.handle('haroo:gen-doll', async function (e, p) {
  const st = keyStatus();
  if (!st.openai) return { ok: false, error: 'ChatGPT(OpenAI) 키를 먼저 연결해줘 (인형 생성은 OpenAI 이미지 사용)' };
  if (!p || !p.imageBase64) return { ok: false, error: '참고 이미지가 필요해요' };
  try { return await genDoll(secrets.get('key.openai'), p.imageBase64, p.prompt); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
// ── 파츠 생성 (텍스트=generations / 이미지=edits) ──
var PARTWORD = {
  eye: 'eye', mouth: 'mouth', hair: 'hairstyle (hair only, no face)',
  face: 'round face base (no hair)', body: 'torso with clothing (no head, no limbs)',
  arm: 'arm', leg: 'leg'
};
function genPart(key, slot, prompt, imageB64) {
  var word = PARTWORD[slot] || 'part';
  var base;
  if (prompt && prompt.trim()) {
    base = 'A cute chibi mascot ' + word + ' clearly themed around "' + prompt.trim() + '" (incorporate that motif into the ' + word + '), front view, centered, thick clean outline, flat pastel colors, simple flat style, transparent background, generous margin so it does not touch the edges, no text.';
  } else {
    base = 'A single cute chibi mascot ' + word + ', front view, centered, thick clean outline, flat pastel colors, simple flat style, transparent background, generous margin, no text.';
  }
  if (imageB64) {
    var buf = Buffer.from(imageB64, 'base64');
    var mp = multipartBody(
      { model: MODEL_IMAGE, prompt: base, size: '1024x1024', background: 'transparent', output_format: 'png', quality: 'low', n: '1' },
      { name: 'image', filename: 'ref.png', contentType: 'image/png', buffer: buf }
    );
    return new Promise(function (resolve) {
      var req = https.request({ method: 'POST', host: 'api.openai.com', path: '/v1/images/edits',
        headers: { 'authorization': 'Bearer ' + key, 'content-type': 'multipart/form-data; boundary=' + mp.boundary, 'content-length': mp.body.length } },
        function (res) { var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {}
          if (res.statusCode === 200 && j && j.data && j.data[0] && j.data[0].b64_json) resolve({ ok: true, b64: j.data[0].b64_json });
          else resolve({ ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + res.statusCode) }); }); });
      req.on('error', function (e) { resolve({ ok: false, error: String((e && e.message) || e) }); });
      req.write(mp.body); req.end();
    });
  } else {
    var body = JSON.stringify({ model: MODEL_IMAGE, prompt: base, size: '1024x1024', background: 'transparent', output_format: 'png', quality: 'low', n: 1 });
    return new Promise(function (resolve) {
      var req = https.request({ method: 'POST', host: 'api.openai.com', path: '/v1/images/generations',
        headers: { 'authorization': 'Bearer ' + key, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        function (res) { var b = ''; res.on('data', function (d) { b += d; }); res.on('end', function () { var j = null; try { j = JSON.parse(b); } catch (e) {}
          if (res.statusCode === 200 && j && j.data && j.data[0] && j.data[0].b64_json) resolve({ ok: true, b64: j.data[0].b64_json });
          else resolve({ ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + res.statusCode) }); }); });
      req.on('error', function (e) { resolve({ ok: false, error: String((e && e.message) || e) }); });
      req.write(body); req.end();
    });
  }
}
ipcMain.handle('haroo:gen-part', async function (e, p) {
  var st = keyStatus();
  if (!st.openai) return { ok: false, error: 'ChatGPT(OpenAI) 키를 먼저 연결해줘' };
  if (!p || !p.slot) return { ok: false, error: '슬롯 정보가 없어요' };
  if (!p.prompt && !p.imageBase64) return { ok: false, error: '텍스트나 이미지를 입력해줘' };
  try { return await genPart(secrets.get('key.openai'), p.slot, p.prompt, p.imageBase64); }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});
function dollsList() { return store.get('dolls') || []; }
function activeDollId() { return store.get('dollActive') || 'default'; }
function activeDollImg() {
  var id = activeDollId(); if (id === 'default') return null;
  var d = dollsList().filter(function (x) { return String(x.id) === String(id); })[0];
  return d ? d.img : null;
}
ipcMain.handle('haroo:get-doll', function () { return activeDollImg(); });
ipcMain.handle('haroo:get-dolls', function () { return { dolls: dollsList(), active: activeDollId() }; });
ipcMain.handle('haroo:add-doll', function (e, p) {
  if (!p || !p.b64) return { dolls: dollsList(), active: activeDollId() };
  var arr = dollsList(); var id = Date.now();
  arr.push({ id: id, name: (p.name || '인형'), img: p.b64 });
  store.set('dolls', arr); store.set('dollActive', id);
  return { dolls: arr, active: id };
});
ipcMain.handle('haroo:set-active-doll', function (e, p) {
  store.set('dollActive', (p && p.id != null) ? p.id : 'default');
  return { img: activeDollImg(), active: activeDollId() };
});
// ── 파츠 인벤토리 (슬롯별 아이템 목록 + 장착 상태) ──
function partItems() { return store.get('partItems') || {}; }
function partEquip() { return store.get('partEquipped') || {}; }
ipcMain.handle('haroo:get-inventory', function () { return { items: partItems(), equipped: partEquip() }; });
ipcMain.handle('haroo:add-item', function (e, p) {
  if (!p || !p.slot || !p.b64) return { items: partItems(), equipped: partEquip() };
  var it = partItems(); var arr = it[p.slot] || []; var id = 'i' + Date.now();
  arr.push({ id: id, name: (p.name || '아이템'), b64: p.b64 }); it[p.slot] = arr; store.set('partItems', it);
  if (p.equip) { var eq = partEquip(); eq[p.slot] = id; store.set('partEquipped', eq); }
  return { items: it, equipped: partEquip(), newId: id };
});
ipcMain.handle('haroo:remove-item', function (e, p) {
  if (!p || !p.slot || !p.id) return { items: partItems(), equipped: partEquip() };
  var it = partItems(); it[p.slot] = (it[p.slot] || []).filter(function (x) { return x.id !== p.id; }); store.set('partItems', it);
  var eq = partEquip(); if (eq[p.slot] === p.id) { delete eq[p.slot]; store.set('partEquipped', eq); }
  return { items: it, equipped: partEquip() };
});
ipcMain.on('haroo:equip', function (e, p) {
  if (!p || !p.slot) return; var eq = partEquip();
  if (p.id && p.id !== 'builtin') eq[p.slot] = p.id; else delete eq[p.slot];
  store.set('partEquipped', eq);
});

ipcMain.handle('haroo:chat', async function (e, payload) {
  const messages = (payload && payload.messages) || [];
  const a = activeProvider();
  if (!a) return { ok: false, error: 'NO_KEY' };
  const key = secrets.get('key.' + a);
  if (!key) return { ok: false, error: 'NO_KEY' };
  try {
    return a === 'claude' ? await callClaude(key, messages) : await callOpenAI(key, messages);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle('haroo:save-key', function (e, info) {
  if (info && (info.provider === 'claude' || info.provider === 'openai')) {
    secrets.set('key.' + info.provider, String(info.key || '').trim());
  }
  return keyStatus();
});
ipcMain.handle('haroo:get-key-status', function () { return keyStatus(); });
ipcMain.handle('haroo:clear-key', function (e, info) {
  if (info && (info.provider === 'claude' || info.provider === 'openai')) secrets.delete('key.' + info.provider);
  return keyStatus();
});
// 채팅창 'API 연결' → 오버레이(하루 창)에 설정 열기 신호
ipcMain.on('haroo:open-ai-settings', function () {
  if (win && !win.isDestroyed() && win.webContents) {
    win.showInactive();
    win.webContents.send('haroo:open-ai-settings');
  }
});

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
let tempTimer = null;             // 첫 실행 8초 임시 표시 타이머
let idleTimer = null;             // 10초 무반응 타이머
let pendingAlert = false;         // 풀스크린이라 보류된 알림
let chatOpen = false;             // 채팅창 열려있는 동안엔 하루가 안 잠듦
let winOpen = false;              // 대시보드/설정 창 열려있는 동안에도 안 잠듦

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
  if (chatOpen || winOpen) return;                     // 채팅/설정창 열림 중엔 안 가라앉음
  if (!win || win.isDestroyed()) { actionMode = false; return; }
  actionMode = false;
  win.setAlwaysOnTop(false);                         // 다른 창이 덮도록
  win.setIgnoreMouseEvents(true, { forward: true }); // 하지만 hit-test 는 유지(보이면 클릭 가능)
  if (win.webContents) win.webContents.send('haroo:action-mode', false);
}

// 앞으로 올리기 (full=true면 전체 클릭, 아니면 hit-test만)
function raiseTop(full) {
  if (!win || win.isDestroyed()) return;
  if (tempTimer) { clearTimeout(tempTimer); tempTimer = null; }
  actionMode = true;
  win.setAlwaysOnTop(true, 'screen-saver');
  if (full) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
  win.showInactive();
  if (win.webContents) win.webContents.send('haroo:action-mode', true);
}
// 잠깐 앞으로 떴다가 ms 후 가라앉기 (첫 실행/하루 부르기용)
function tempRaise(ms) {
  raiseTop(false);
  tempTimer = setTimeout(function () { tempTimer = null; exitAction(); }, ms || 8000);
}

/* ---- 무반응 타이머 갱신 (건드림/드래그/새 알림마다 호출) ---- */
function refreshIdle() { /* 비활성: 평소 항상 가라앉음 */ }

/* ============================================================
 *  오버레이 적응 (데모 페이지에 주입)
 * ============================================================ */
const OVERLAY_CSS = `
  .haru-spin{display:inline-block;width:13px;height:13px;vertical-align:-2px;margin-right:6px;
    border:2px solid rgba(0,0,0,.15);border-top-color:var(--coral,#E58A6B);border-radius:50%;
    animation:harooSpin .8s linear infinite}
  @keyframes harooSpin{to{transform:rotate(360deg)}}

  /* 하누 인형: 오른손(arm-r)에 들림 — 어깨축으로 arm-r과 동일 회전 */
  .char-body .haru-doll{
    position:absolute;
    left:50px; top:62px; width:36px; height:45px;   /* ← 위치/크기 (조정용) */
    z-index:27; pointer-events:none; object-fit:contain;  /* 비율 유지 → 안 늘어남 */
    transform-box:fill-box;
    transform-origin:-0.23px -1.48px;               /* arm-r 어깨점 (top에 연동) */
  }
  #charLayer[data-state="walk"]     .haru-doll{ animation:stepA .46s ease-in-out infinite; }
  #charLayer[data-state="dragging"] .haru-doll{ transform:rotate(28deg); }
  #charLayer[data-state="eat"]      .haru-doll{ animation:sip 1.5s ease-in-out infinite; }
  #charLayer[data-state="work"]     .haru-doll{ animation:typ .32s .16s ease-in-out infinite; }

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
    if (window.__harooWinOpen) return;   // 창 열림 동안엔 전체 클릭 (hit-test 스킵)
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

  // ── 6) 대화 AI 연결: Claude/ChatGPT(gpt)만 노출 + 실제 키 저장 ──
  (function () {
    try {
      if (typeof AI_PROVIDERS !== 'undefined' && Array.isArray(AI_PROVIDERS)) {
        for (var i = AI_PROVIDERS.length - 1; i >= 0; i--) {
          if (AI_PROVIDERS[i].id !== 'claude' && AI_PROVIDERS[i].id !== 'gpt') AI_PROVIDERS.splice(i, 1);
        }
      }
    } catch (_) {}
    // 연결됨 행에 '수정' 버튼 추가 (renderAiList 래핑 → 매 렌더 후 부착)
    try {
      if (typeof renderAiList === 'function' && !renderAiList.__wrapped) {
        var _origRender = renderAiList;
        window.renderAiList = function () {
          _origRender.apply(this, arguments);
          try { addEditBtns(); } catch (_) {}
        };
        window.renderAiList.__wrapped = true;
      }
    } catch (_) {}
    function addEditBtns() {
      var wrap = document.getElementById('aiList'); if (!wrap) return;
      var tags = wrap.querySelectorAll('.ai-on-tag');
      Array.prototype.forEach.call(tags, function (tag) {
        var act = tag.parentNode; if (!act || act.querySelector('[data-edit]')) return;
        var useBtn = act.querySelector('[data-use]');
        var id = useBtn ? useBtn.getAttribute('data-use') : null; if (!id) return;
        var btn = document.createElement('button');
        btn.className = 'ai-btn'; btn.setAttribute('data-edit', id);
        btn.textContent = '수정'; btn.style.marginLeft = '4px';
        btn.onclick = function () {
          var box = document.getElementById('aikey-' + id);
          if (box) box.style.display = (box.style.display === 'flex') ? 'none' : 'flex';
        };
        act.appendChild(btn);
      });
    }
    var REAL = { claude: 'claude', gpt: 'openai' };
    document.addEventListener('click', function (e) {
      var sv = e.target.closest ? e.target.closest('[data-save]') : null;
      if (sv) {
        var sid = sv.getAttribute('data-save');
        if (REAL[sid]) {
          var inp = document.getElementById('aikin-' + sid);
          var v = inp ? (inp.value || '').trim() : '';
          if (v && window.haroo && window.haroo.saveAiKey) window.haroo.saveAiKey(REAL[sid], v);
          if (window.haroo && window.haroo.setActiveAi) window.haroo.setActiveAi(REAL[sid]); // 연결=사용 중
        }
        return;
      }
      var us = e.target.closest ? e.target.closest('[data-use]') : null;
      if (us) {
        var uid = us.getAttribute('data-use');
        if (REAL[uid] && window.haroo && window.haroo.setActiveAi) window.haroo.setActiveAi(REAL[uid]);
      }
    }, true);
    if (window.haroo && window.haroo.aiKeyStatus) {
      window.haroo.aiKeyStatus().then(function (st) {
        try {
          if (typeof store !== 'undefined' && store.ai && store.ai.connected) {
            if (st && st.claude) store.ai.connected['claude'] = true;
            if (st && st.openai) store.ai.connected['gpt'] = true;
            if (typeof renderAiList === 'function') renderAiList();
          }
        } catch (_) {}
      }).catch(function () {});
    }
    if (window.haroo && window.haroo.onOpenAiSettings) {
      window.haroo.onOpenAiSettings(function () {
        try { if (typeof openWin === 'function') openWin('settings'); } catch (_) {}
        try { if (typeof gotoPage === 'function') gotoPage('character'); } catch (_) {}
      });
    }
    // 캐릭터 설정(이름/역할/말투) → 메인 시스템 프롬프트에 반영
    function reportPersona() {
      try {
        if (typeof store !== 'undefined' && store.char && window.haroo && window.haroo.setPersona) {
          window.haroo.setPersona({ name: store.char.name, role: store.char.role, personality: store.char.personality });
        }
      } catch (_) {}
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#saveChar')) setTimeout(reportPersona, 0);
    }, false);
    reportPersona();
  })();

  // ── 7) 하누 인형을 오른손(arm-r) 옆에 부착 ──
  (function () {
    function placeDoll() {
      var body = document.querySelector('.char-body');
      if (!body || body.querySelector('.haru-doll')) return;
      var arm = body.querySelector('.arm-r');
      var doll = document.createElement('img');
      doll.className = 'part haru-doll';
      doll.alt = '';
      doll.src = 'haru-doll.png'; // renderer/haru-doll.png
      if (arm && arm.nextSibling) body.insertBefore(doll, arm.nextSibling);
      else body.appendChild(doll);
    }
    placeDoll();
    // 저장된(생성한) 인형이 있으면 적용
    if (window.haroo && window.haroo.getDoll) {
      window.haroo.getDoll().then(function (b64) {
        if (b64) { var d = document.querySelector('.char-body .haru-doll'); if (d) d.src = 'data:image/png;base64,' + b64; }
      }).catch(function () {});
    }
    // char-body가 다시 그려질 경우 대비 (안전망)
    try {
      var host = document.querySelector('.char-svg') || document.body;
      var mo = new MutationObserver(function () { placeDoll(); });
      mo.observe(host, { childList: true, subtree: true });
    } catch (_) {}
  })();

  // ── 8) 캐릭터/인형 생성 UI 재구성 (하루=메인, 캐릭터 생성=추후, 인형 생성=현 UI) ──
  (function () {
    function relabelGen() {
      var t = document.querySelector('#charGen .win-title');
      if (t) t.innerHTML = '<span class="wt-ico">🧸</span> 인형 생성';
      var intro = document.querySelector('#charGen .gen-intro');
      if (intro) intro.innerHTML = '이름·외형을 정하거나 참고 이미지를 올리면, 하루가 <b>손에 들고 다닐 인형</b>으로 만들어줘요.' +
        '<span class="gen-demo">데모 · 실제 생성은 PC판에서 API 연동</span>';
      var go = document.getElementById('genGo'); if (go) go.textContent = '✨ 인형 만들기';
      var gName = document.getElementById('gName'); if (gName) gName.placeholder = '예: 하누';
      var gP = document.getElementById('gPrompt'); if (gP) gP.placeholder = '예: 파스텔톤, 동글동글, 큰 눈';
    }
    relabelGen();

    function fixCards() {
      var list = document.getElementById('charList'); if (!list) return;
      var nm = list.querySelector('#clAdd .cl-name'); if (nm) nm.textContent = '인형 생성';
      var ic = list.querySelector('#clAdd .plus'); if (ic) ic.textContent = '🧸';
      if (!list.querySelector('#clSoon')) {
        var soon = document.createElement('div');
        soon.className = 'cl-card cl-add'; soon.id = 'clSoon';
        soon.style.opacity = '.55'; soon.style.cursor = 'not-allowed'; soon.style.borderStyle = 'solid';
        soon.innerHTML = '<div class="plus">🔒</div><div class="cl-name" style="color:inherit">캐릭터 생성<br><span style="font-size:9px;opacity:.8">추후 제공</span></div>';
        soon.addEventListener('click', function (e) {
          e.stopPropagation();
          try { if (typeof toast === 'function') toast('캐릭터 생성은 곧 제공돼요!', '🔒'); } catch (_) {}
        });
        var clAdd = list.querySelector('#clAdd');
        if (clAdd && clAdd.nextSibling) list.insertBefore(soon, clAdd.nextSibling);
        else list.appendChild(soon);
      }
    }
    if (typeof renderCharList === 'function' && !renderCharList.__wrapped) {
      var _orig = renderCharList;
      window.renderCharList = function () { _orig.apply(this, arguments); try { fixCards(); } catch (_) {} };
      window.renderCharList.__wrapped = true;
    }
    fixCards();
  })();

  // ── 9) 인형 생성: 참고이미지+프롬프트 → OpenAI 이미지 → 하루 손 인형 교체 ──
  (function () {
    function processDoll(b64) {
      return new Promise(function (res) {
        var img = new Image();
        img.onload = function () {
          var w0 = img.width, h0 = img.height;
          var c0 = document.createElement('canvas'); c0.width = w0; c0.height = h0;
          var x0 = c0.getContext('2d'); x0.drawImage(img, 0, 0);
          var px;
          try { px = x0.getImageData(0, 0, w0, h0).data; } catch (e) { res(b64); return; }
          // (1) 배경 불투명 → 코너색 제거
          if (px[3] > 200) {
            var cr = px[0], cg = px[1], cb = px[2];
            var dd = x0.getImageData(0, 0, w0, h0), p2 = dd.data;
            for (var i = 0; i < p2.length; i += 4) {
              if (Math.abs(p2[i] - cr) + Math.abs(p2[i + 1] - cg) + Math.abs(p2[i + 2] - cb) < 60) p2[i + 3] = 0;
            }
            x0.putImageData(dd, 0, 0); px = dd.data;
          }
          // (2) 불투명 영역 bbox 찾기
          var minX = w0, minY = h0, maxX = 0, maxY = 0, found = false;
          for (var y = 0; y < h0; y++) {
            for (var xx = 0; xx < w0; xx++) {
              if (px[(y * w0 + xx) * 4 + 3] > 20) { found = true; if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; if (y < minY) minY = y; if (y > maxY) maxY = y; }
            }
          }
          if (!found) { res(c0.toDataURL('image/png').split(',')[1]); return; }
          var cw = maxX - minX + 1, ch = maxY - minY + 1;
          // (3) 정사각 + 14% 여백에 중앙 배치 → 머리·발 안 잘림
          var side = Math.max(cw, ch);
          var pad = Math.round(side * 0.14);
          var out = side + pad * 2;
          var scale = Math.min(1, 256 / out);
          var fw = Math.round(out * scale);
          var cc = document.createElement('canvas'); cc.width = fw; cc.height = fw;
          var xc = cc.getContext('2d');
          var ox = (out - cw) / 2, oy = (out - ch) / 2;
          xc.drawImage(c0, minX, minY, cw, ch, ox * scale, oy * scale, cw * scale, ch * scale);
          res(cc.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = function () { res(b64); };
        img.src = 'data:image/png;base64,' + b64;
      });
    }
    function applyDoll(b64) {
      var d = document.querySelector('.char-body .haru-doll');
      if (d) d.src = 'data:image/png;base64,' + b64;
    }
    async function genDollRun() {
      var promptEl = document.getElementById('gPrompt');
      var prompt = (promptEl && promptEl.value || '').trim();
      if (typeof genImg === 'undefined' || !genImg) { try { if (typeof toast === 'function') toast('참고 이미지를 올려주세요', '🖼️'); } catch (_) {} return; }
      var up = document.getElementById('genUp'), prog = document.getElementById('genProg'), status = document.getElementById('genStatus'), slots = document.getElementById('genSlots');
      if (up) up.style.display = 'none';
      if (prog) prog.style.display = '';
      if (slots) slots.innerHTML = '';
      if (status) status.innerHTML = '<span class="haru-spin"></span>인형 생성 중… (최대 1분)';
      try { if (typeof setState === 'function') setState('thinking', 999999); } catch (_) {}
      var refB64 = String(genImg).split(',')[1];
      try {
        var r = await window.haroo.genDoll({ imageBase64: refB64, prompt: prompt });
        if (!r || !r.ok) {
          if (status) status.textContent = '실패: ' + ((r && r.error) || '오류');
          try { if (typeof setState === 'function') setState('idle'); } catch (_) {}
          setTimeout(function () { if (prog) prog.style.display = 'none'; if (up) up.style.display = ''; }, 3000);
          return;
        }
        if (status) status.innerHTML = '<span class="haru-spin"></span>배경 정리 중…';
        var clean = await processDoll(r.b64);
        applyDoll(clean);
        var nameEl = document.getElementById('gName');
        var nm = (nameEl && nameEl.value || '').trim() || '인형';
        try { await window.haroo.addDoll({ name: nm, b64: clean }); if (window.renderDollList) window.renderDollList(); } catch (_) {}
        if (status) status.textContent = '완성! 하루가 인형을 들었어요 🧸';
        try { if (typeof setState === 'function') setState('happy', 1400); } catch (_) {}
        try { if (typeof toast === 'function') toast('인형 완성!', '🧸'); } catch (_) {}
        setTimeout(function () { try { if (typeof closeWin === 'function') closeWin('charGen'); if (typeof genReset === 'function') genReset(); } catch (_) {} }, 1300);
      } catch (e) {
        if (status) status.textContent = '오류: ' + e;
      }
    }
    var go = document.getElementById('genGo');
    if (go) go.onclick = genDollRun;
  })();

  // ── 10) 인형 리스트 (기본 하누 + 만든 인형들, 카드 클릭 → 교체) ──
  (function () {
    function injectListUI() {
      var form = document.querySelector('.set-form');
      if (!form || document.getElementById('dollList')) return;
      var sec = document.createElement('div');
      sec.innerHTML = '<div class="sect-div"></div><div class="fld"><label>🧸 인형 리스트 <span style="color:var(--ink-faint);font-weight:400">· 누르면 하루가 바꿔 들어요</span></label><div class="char-list" id="dollList"></div></div>';
      while (sec.firstChild) form.appendChild(sec.firstChild);
    }
    window.renderDollList = function () {
      var wrap = document.getElementById('dollList');
      if (!wrap || !window.haroo || !window.haroo.getDolls) return;
      window.haroo.getDolls().then(function (st) {
        var dolls = (st && st.dolls) || [], active = (st && st.active != null) ? String(st.active) : 'default';
        var html = '<div class="cl-card' + (active === 'default' ? ' on' : '') + '" data-doll="default"><div class="cl-av"><img src="haru-doll.png" style="width:100%;height:100%;object-fit:contain"></div><div class="cl-name">하누</div></div>';
        dolls.forEach(function (d) {
          html += '<div class="cl-card' + (active === String(d.id) ? ' on' : '') + '" data-doll="' + d.id + '"><div class="cl-av"><img src="data:image/png;base64,' + d.img + '" style="width:100%;height:100%;object-fit:contain"></div><div class="cl-name">' + (d.name || '인형') + '</div></div>';
        });
        wrap.innerHTML = html;
        Array.prototype.forEach.call(wrap.querySelectorAll('[data-doll]'), function (card) {
          card.onclick = function () {
            var id = card.getAttribute('data-doll');
            window.haroo.setActiveDoll(id === 'default' ? 'default' : Number(id)).then(function (r) {
              var d = document.querySelector('.char-body .haru-doll');
              if (d) d.src = (r && r.img) ? ('data:image/png;base64,' + r.img) : 'haru-doll.png';
              window.renderDollList();
            });
          };
        });
      }).catch(function () {});
    };
    injectListUI();
    window.renderDollList();
  })();

  // ── 11) 대시보드/설정 창 열림 동안 하루 최상위 유지 (.win.show 관찰) ──
  (function () {
    function anyOpen() { return !!document.querySelector('.win.show'); }
    var last = null;
    function check() {
      var open = anyOpen();
      if (open === last) return; last = open;
      window.__harooWinOpen = open;
      if (!window.haroo) return;
      if (open && window.haroo.uiOpen) window.haroo.uiOpen();
      else if (!open && window.haroo.uiClosed) window.haroo.uiClosed();
    }
    try {
      var mo = new MutationObserver(check);
      Array.prototype.forEach.call(document.querySelectorAll('.win'), function (w) {
        mo.observe(w, { attributes: true, attributeFilter: ['class'] });
      });
    } catch (_) {}
    check();
  })();

  // ── 다국어 (영어 기본 / 한국어) — 텍스트 교체만, 클릭/창 코드 안 건드림 ──
  (function () {
    var DICT = {
      'HAROO 대시보드':'HAROO Dashboard','워크스페이스':'Workspace','오늘 한눈에':'Overview',
      '태스크':'Tasks','곧 추가될 기능':'Coming soon','프로젝트':'Projects','데일리 체크인':'Daily check-in',
      '회의 노트':'Meeting notes','샘플':'Sample','V0에선 샘플 화면으로 시연돼요':'Shown as a sample screen',
      '캐릭터 설정':'Character Settings','캐릭터':'Character','이름':'Name','역할':'Role','말투':'Tone',
      '나의 업무 비서':'My work assistant','선택한 캐릭터 · 이름':'Selected character · name',
      '변경사항 저장':'Save changes','💬 대화 AI 연결':'💬 Chat AI Connection',
      '· 연결하면 목록에 활성화돼요':'· Connect to activate','캐릭터 리스트':'Character list',
      '· 6종 중 1개':'· 1 of 6','· 만들 때마다 채워져요':'· Fills as you create','· 선택':'· select',
      '또는 클릭해서 선택':'or click to select','참고 이미지':'Reference image','외형 프롬프트':'Appearance prompt',
      '이미지 끌어다 놓기':'Drag image here','이미지를 끌어다 놓거나 클릭':'Drag an image or click',
      '이미지 분석 중…':'Analyzing image…','인식하는 중…':'Recognizing…','동일한 파츠 세트':'Same part set',
      '조립 완료! 리스트에 추가할까요?':'Done! Add to the list?',
      '📸 화면 캡처':'📸 Screen Capture','지금 화면 캡처하기':'Capture screen now',
      '카톡·메일 스크린샷 파일':'KakaoTalk/email screenshot','📋 텍스트':'📋 Text','🖼️ 이미지':'🖼️ Image',
      '✨ 할 일 추출하기':'✨ Extract tasks','태스크에 추가하기':'Add to tasks',
      '맞는지 확인하고 고친 뒤 추가하세요 · 사람이 검토하는 단계예요':'Review and edit before adding',
      '✅ 이렇게 정리했어요':'✅ Here is the summary','한국어·영어 섞여 있어도 인식해요':'Works with mixed Korean/English',
      '캐릭터 숨기기':'Hide character','종료':'Quit','안녕하세요! 오늘도 잘 부탁해요 🌷':'Hi! Let us have a great day 🌷',
      '다정':'Sweet','시크':'Chic','발랄':'Cheerful','차분':'Calm','츤데레':'Tsundere','프로':'Pro',
      '인형 생성':'Create Doll','캐릭터 생성':'Create Character','추후 제공':'Coming soon',
      '🧸 인형 리스트':'🧸 Doll list','· 누르면 하루가 바꿔 들어요':'· tap to swap','하누':'Hanu','인형':'Doll',
      '수정':'Edit','✨ 인형 만들기':'✨ Make Doll',
      '남은 할 일':'Remaining','긴급 항목':'Urgent','오늘 완료':'Done today','태스크 보기':'View tasks',
      '빠른 작업':'Quick actions','할 일':'To do','진행 중':'In progress','검토':'Review','완료':'Done',
      '무리하지 말고 한 걸음씩 가요 :)':'One step at a time, no rush :)',
      '오늘도 옆에서 응원할게요!':'Cheering you on today!','물 한 잔 마시고 올까요?':'Maybe grab some water?',
      '...왔구나. 시작하자.':'...You are here. Let us start.','해야 할 거, 알지?':'You know what to do, right?',
      '...집중.':'...Focus.','시간 가고 있어.':'Time is ticking.','헤헤 저 여기 있어요!':'Hehe I am right here!',
      '오늘 뭐부터 할까요?!':'What should we start with?!','파이팅 넘치는 하루!! 💪':'A day full of energy!! 💪',
      '잠시 쉬어가도 괜찮아요.':'It is okay to take a break.','하나씩 차근히 해봐요.':'Let us go one by one.',
      '지금 이 순간에 집중해요.':'Focus on this moment.','너 걱정해서 알려주는 거 아니야!':'Not because I am worried, okay!',
      '빨리 안 해?':'Get going already.','...잘하고 있네. (작게)':'...You are doing well. (quietly)',
      '처리할 항목을 확인해 주세요.':'Please check the items.','우선순위를 점검하시겠어요?':'Shall we review priorities?',
      '보고 드릴 사항이 있습니다.':'I have something to report.',
      '이 기능은 다음 버전에서 실제로 동작해요':'This feature works in the next version','팀 단위 프로젝트 관리 · V0에선 샘플만 보여드려요':'Team project management · sample only','매일의 컨디션·집중도를 기록 · V0 샘플':'Track daily mood & focus · sample','회의 내용에서 할 일을 자동 추출 · V0 샘플':'Auto-extract tasks from meetings · sample','데일리 체크인':'Daily check-in','회의 노트':'Meeting notes','프로젝트':'Projects','오늘':'Today','어제':'Yesterday','그제':'2 days ago','좋음':'Good','보통':'Okay','최고':'Great','집중 4시간':'4h focus','집중 2.5시간':'2.5h focus','집중 5시간':'5h focus','기획':'Planning','액션 3건':'3 actions','액션 5건':'5 actions','액션 2건':'2 actions','3/8 태스크':'3/8 tasks','0/12 태스크':'0/12 tasks','5/9 태스크':'5/9 tasks','STO 리뉴얼':'STO Renewal','신규 IP 런칭':'New IP Launch','해외 영업 Q3':'Overseas Sales Q3','주간 영업 회의':'Weekly Sales Meeting','IP 기획 리뷰':'IP Planning Review','바이어 미팅':'Buyer Meeting','😊 좋음':'😊 Good','😐 보통':'😐 Okay','🔥 최고':'🔥 Great','따뜻하게':'Warmly','쿨하게':'Coolly','활기차게':'Energetically','잔잔하게':'Calmly','새침하게':'Coyly','비서처럼':'Like a secretary','캡처하거나 직접 추가한 할 일이 모여요.':'Captured and added tasks gather here.','태스크 추가':'Add task','전체':'All',
      '제어':'Controls','눈':'Eyes','입':'Mouth','머리카락':'Hair','얼굴':'Face','몸통':'Body','팔':'Arms','다리':'Legs','🧩 파츠 인벤토리':'🧩 Parts inventory','· 슬롯에 이미지를 올리면 그 자리에만 적용':'· Upload an image to fill that slot only','이미지 올리기':'Upload image','기본값':'Default'
    };
    var INV = null;
    function inv(){ if(INV) return INV; INV={}; for(var k in DICT) INV[DICT[k]]=k; return INV; }
    function cur(){ return window.__hLang || 'en'; }
    function tr(s, lang){
      var key=s.replace(/^\s+|\s+$/g,''); if(!key) return s;
      var lead=s.match(/^\s*/)[0], trail=s.match(/\s*$/)[0];
      var map=(lang==='en')?DICT:inv();
      if(map[key]!=null) return lead+map[key]+trail;
      var m=key.match(/^([^\uAC00-\uD7A3A-Za-z0-9]+\s*)(.+)$/);
      if(m && map[m[2]]!=null) return lead+m[1]+map[m[2]]+trail;
      return s;
    }
    function walk(lang){
      var w=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null), ns=[], n;
      while(n=w.nextNode()) ns.push(n);
      ns.forEach(function(t){ var v=t.nodeValue; if(!v||!v.replace(/\s/g,'')) return; var nx=tr(v,lang); if(nx!==v) t.nodeValue=nx; });
      Array.prototype.forEach.call(document.querySelectorAll('[placeholder]'), function(el){
        var key=(el.getAttribute('placeholder')||'').replace(/^\s+|\s+$/g,'');
        var map=(lang==='en')?DICT:inv(); if(map[key]!=null) el.setAttribute('placeholder', map[key]);
      });
    }
    function ctlLabels(lang){
      var L=lang==='en';
      var g=document.getElementById('hCtlG'); if(g) g.textContent=L?'Controls':'제어';
      var a=document.querySelector('#hLangBtn .nl'); if(a) a.textContent=L?'English':'한국어';
      var q=document.querySelector('#hQuitBtn .nl'); if(q) q.textContent=L?'Quit':'종료';
      if(window.haroo && window.haroo.chatState) window.haroo.chatState().then(function(open){
        var c=document.querySelector('#hChatBtn .nl'); if(c) c.textContent=open?(L?'Close Chat':'채팅 닫기'):(L?'Open Chat':'채팅 열기');
      });
    }
    var NAV_EN={'overview':'Overview','tasks':'Tasks','capture-page':'Quick Capture','projects':'Projects','checkin-page':'Daily check-in','meeting':'Meeting notes','character':'Character Settings'};
    var NAV_KO={'overview':'오늘 한눈에','tasks':'태스크','capture-page':'Quick Capture','projects':'프로젝트','checkin-page':'데일리 체크인','meeting':'회의 노트','character':'캐릭터 설정'};
    function fixNav(lang){
      var map=(lang==='en')?NAV_EN:NAV_KO;
      Array.prototype.forEach.call(document.querySelectorAll('.nav-item[data-page]'), function(it){
        var dp=it.getAttribute('data-page'), label=map[dp]; if(label==null) return;
        for(var i=0;i<it.childNodes.length;i++){
          var nd=it.childNodes[i];
          if(nd.nodeType===3 && nd.nodeValue.replace(/\s/g,'')){ nd.nodeValue=' '+label+' '; break; }
        }
      });
    }
    window.__hApply=function(lang){ window.__hLang=lang; try{document.documentElement.setAttribute('lang',lang);}catch(e){} walk(lang); fixNav(lang); ctlLabels(lang); };

    function injectCtl(){
      var nav=document.getElementById('dashNav'); if(!nav || document.getElementById('hCtlG')) return;
      var box=document.createElement('div');
      box.innerHTML='<div class="nav-group" id="hCtlG" style="margin-top:14px">Controls</div>'+
        '<div class="nav-item" id="hChatBtn" style="cursor:pointer"><span class="ni">💬</span> <span class="nl">Open Chat</span></div>'+
        '<div class="nav-item" id="hLangBtn" style="cursor:pointer"><span class="ni">🌐</span> <span class="nl">English</span></div>'+
        '<div class="nav-item" id="hQuitBtn" style="cursor:pointer"><span class="ni">⏻</span> <span class="nl">Quit</span></div>';
      while(box.firstChild) nav.appendChild(box.firstChild);
      document.getElementById('hChatBtn').addEventListener('click', function(){ if(window.haroo&&window.haroo.toggleChat) window.haroo.toggleChat().then(function(){ ctlLabels(cur()); }); });
      document.getElementById('hLangBtn').addEventListener('click', function(){ var nx=cur()==='en'?'ko':'en'; window.__hApply(nx); if(window.haroo&&window.haroo.setLang) window.haroo.setLang(nx); });
      document.getElementById('hQuitBtn').addEventListener('click', function(){ var L=cur()==='en'; if(window.confirm(L?'Quit HAROO?':'하루를 종료할까요?')){ if(window.haroo&&window.haroo.quitApp) window.haroo.quitApp(); } });
    }

    // 아무 클릭 후 재번역 (가벼운 패시브 리스너 — 클릭 처리엔 영향 없음)
    var _t=null;
    document.addEventListener('click', function(){
      if(_t) return;
      _t=setTimeout(function(){ _t=null; window.__hApply(cur()); }, 60);
      setTimeout(function(){ window.__hApply(cur()); }, 320);
    }, false);

    // 초기 적용 (기본 영어)
    function go(l){ window.__hLang=l||'en'; injectCtl(); window.__hApply(window.__hLang); setTimeout(function(){ window.__hApply(window.__hLang); }, 250); }
    function init(){ injectCtl(); if(window.haroo&&window.haroo.getLang){ window.haroo.getLang().then(go); } else { go('en'); } }
    init();
  })();

  // ── 13) 파츠 인벤토리 (슬롯별 아이템 보관 · 장착/생성/삭제) ──
  (function () {
    var SLOTS = [
      { id:'eye',   ko:'눈',     sel:'.part.eye',   pos:'left:0;top:64px' },
      { id:'mouth', ko:'입',     sel:'.part.mouth-idle, .part.mouth-talk', pos:'right:0;top:64px' },
      { id:'hair',  ko:'머리카락', sel:'.part.hair',  pos:'left:62px;top:-6px' },
      { id:'face',  ko:'얼굴',    sel:'.part.face',  pos:'right:62px;top:-6px' },
      { id:'body',  ko:'몸통',    sel:'.part.body',  pos:'right:0;top:140px' },
      { id:'arm',   ko:'팔',     sel:'.part.arm',   pos:'left:0;top:140px' },
      { id:'leg',   ko:'다리',    sel:'.part.leg',   pos:'left:99px;top:200px' }
    ];
    var origMap = new WeakMap();
    var INV = { items:{}, equipped:{} };
    function bySlot(id){ return SLOTS.filter(function(x){return x.id===id;})[0]; }
    function scoped(sel){ return sel.split(',').map(function(x){ return '#charLayer ' + x.trim(); }).join(', '); }
    function slotEls(s){ return Array.prototype.slice.call(document.querySelectorAll(scoped(s.sel))); }
    function refreshPreview(){ try{ if(typeof mountAvatar==='function' && document.getElementById('pvChar')) mountAvatar('#pvChar', 130); }catch(e){} }
    function captureOrig(){ SLOTS.forEach(function(s){ slotEls(s).forEach(function(el){ if(!origMap.has(el)) origMap.set(el, el.getAttribute('src')); }); }); }
    function builtinSrc(id){ var els=slotEls(bySlot(id)); for(var i=0;i<els.length;i++){ if(origMap.has(els[i])) return origMap.get(els[i]); } return ''; }
    var MIRROR = { eye:true, arm:true, leg:true }; // 좌우 쌍 → 2번째 요소는 좌우반전
    function flipB64(b64, cb){ var img=new Image();
      img.onload=function(){ var c=document.createElement('canvas'); c.width=img.width; c.height=img.height; var x=c.getContext('2d'); x.translate(img.width,0); x.scale(-1,1); x.drawImage(img,0,0); cb(c.toDataURL('image/png')); };
      img.onerror=function(){ cb('data:image/png;base64,'+b64); }; img.src='data:image/png;base64,'+b64; }
    function applyItemSrc(id, b64, done){
      var els=slotEls(bySlot(id)); var src='data:image/png;base64,'+b64;
      if(MIRROR[id] && els.length>1){
        flipB64(b64, function(flipped){ els.forEach(function(el,i){ el.style.objectFit='contain'; el.setAttribute('src', i===0?src:flipped); }); if(done)done(); });
      } else {
        els.forEach(function(el){ el.style.objectFit='contain'; el.setAttribute('src', src); }); if(done)done();
      }
    }
    function equipBuiltin(id){ slotEls(bySlot(id)).forEach(function(el){ if(origMap.has(el)){ el.setAttribute('src', origMap.get(el)); el.style.objectFit=''; } }); }
    function itemsOf(id){ return INV.items[id] || []; }
    function applyEquipped(id){
      var eqId = INV.equipped[id];
      var item = itemsOf(id).filter(function(x){return x.id===eqId;})[0];
      if(item) applyItemSrc(id, item.b64, function(){ refreshPreview(); updateRing(); });
      else { equipBuiltin(id); refreshPreview(); updateRing(); }
    }

    function processPart(b64){ return new Promise(function(res){ var img=new Image();
      img.onload=function(){ var w0=img.width,h0=img.height; var c0=document.createElement('canvas'); c0.width=w0; c0.height=h0; var x0=c0.getContext('2d'); x0.drawImage(img,0,0);
        var px; try{ px=x0.getImageData(0,0,w0,h0).data; }catch(e){ res(b64); return; }
        var minX=w0,minY=h0,maxX=0,maxY=0,f=false;
        for(var y=0;y<h0;y++)for(var x=0;x<w0;x++){ if(px[(y*w0+x)*4+3]>20){ f=true; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; } }
        if(!f){ res(b64); return; } var cw=maxX-minX+1,ch=maxY-minY+1; var sc=Math.min(1,256/Math.max(cw,ch));
        var fw=Math.max(1,Math.round(cw*sc)),fh=Math.max(1,Math.round(ch*sc)); var cc=document.createElement('canvas'); cc.width=fw; cc.height=fh;
        cc.getContext('2d').drawImage(c0,minX,minY,cw,ch,0,0,fw,fh); res(cc.toDataURL('image/png').split(',')[1]); };
      img.onerror=function(){ res(b64); }; img.src='data:image/png;base64,'+b64; }); }
    function fileToB64(file, cb){ var r=new FileReader(); r.onload=function(){ var img=new Image();
      img.onload=function(){ var max=256, sc=Math.min(1,max/Math.max(img.width,img.height)); var w=Math.max(1,Math.round(img.width*sc)),h=Math.max(1,Math.round(img.height*sc));
        var c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(img,0,0,w,h); cb(c.toDataURL('image/png').split(',')[1]); };
      img.onerror=function(){ cb(null); }; img.src=r.result; }; r.readAsDataURL(file); }

    // 하루 둘레 슬롯 링
    function buildRing(){ var pv=document.querySelector('.set-preview .pv-char'); if(!pv) return; if(document.getElementById('equipRing')) return;
      var ring=document.createElement('div'); ring.id='equipRing'; ring.style.cssText='position:relative;width:240px;height:250px;margin:0 auto;flex:0 0 auto';
      pv.parentNode.insertBefore(ring, pv); pv.style.position='absolute'; pv.style.left='55px'; pv.style.top='60px'; ring.appendChild(pv);
      SLOTS.forEach(function(s){ var b=document.createElement('div'); b.className='equip-slot'; b.dataset.slot=s.id;
        b.style.cssText='position:absolute;'+s.pos+';width:44px;height:44px;border-radius:11px;border:2px solid var(--line);background:var(--surface);box-shadow:0 1px 4px rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:.15s';
        b.innerHTML='<img style="max-width:32px;max-height:32px;object-fit:contain"><span style="position:absolute;bottom:-15px;font-size:9px;color:var(--ink-soft);white-space:nowrap">'+s.ko+'</span>';
        b.onmouseenter=function(){ b.style.borderColor='var(--brand,#f06)'; b.style.transform='scale(1.08)'; };
        b.onmouseleave=function(){ b.style.borderColor='var(--line)'; b.style.transform='scale(1)'; };
        b.onclick=function(){ openEditor(s.id); }; ring.appendChild(b); }); updateRing(); }
    function updateRing(){ SLOTS.forEach(function(s){ var el=document.querySelector(scoped(s.sel)); var src=el?el.getAttribute('src'):'';
      var b=document.querySelector('.equip-slot[data-slot="'+s.id+'"] img'); if(b) b.src=src; }); }

    // ── 슬롯 편집 팝업 ──
    function closeEditor(){ var e=document.getElementById('slotEditor'); if(e) e.remove(); }
    function openEditor(id){ closeEditor(); var s=bySlot(id); if(!s) return; var refB64=null;
      var ov=document.createElement('div'); ov.id='slotEditor';
      ov.style.cssText='position:fixed;inset:0;z-index:99999;background:rgba(20,22,45,.4);display:flex;align-items:center;justify-content:center';
      ov.innerHTML='<div id="seBox" style="width:360px;max-width:92%;max-height:86vh;overflow:auto;background:var(--surface);border-radius:16px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.25)"></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', function(e){ if(e.target===ov) closeEditor(); });
      function setRefLabel(){ var d=document.getElementById('seDrop'); if(d) d.textContent = refB64 ? '참고 이미지 첨부됨 ✓ (다시=교체)' : '참고 이미지(선택) 드래그/클릭'; }
      function render(){
        var box=document.getElementById('seBox');
        var eqId = INV.equipped[id] || 'builtin';
        var cards = '<div class="seCard'+(eqId==='builtin'?' on':'')+'" data-eq="builtin" style="position:relative;border:2px solid '+(eqId==='builtin'?'var(--brand,#f06)':'var(--line)')+';border-radius:10px;padding:6px;cursor:pointer;text-align:center"><div style="height:42px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);border-radius:7px"><img src="'+builtinSrc(id)+'" style="max-width:34px;max-height:34px;object-fit:contain"></div><div style="font-size:10px;margin-top:3px">기본</div></div>';
        itemsOf(id).forEach(function(it){ var on=eqId===it.id;
          cards += '<div class="seCard'+(on?' on':'')+'" data-eq="'+it.id+'" style="position:relative;border:2px solid '+(on?'var(--brand,#f06)':'var(--line)')+';border-radius:10px;padding:6px;cursor:pointer;text-align:center"><div style="height:42px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);border-radius:7px"><img src="data:image/png;base64,'+it.b64+'" style="max-width:34px;max-height:34px;object-fit:contain"></div><div style="font-size:10px;margin-top:3px">'+(it.name||'아이템')+'</div><span class="seDel" data-del="'+it.id+'" style="position:absolute;top:-7px;right:-7px;width:18px;height:18px;border-radius:50%;background:#e44;color:#fff;font-size:12px;line-height:18px;text-align:center;cursor:pointer">×</span></div>'; });
        box.innerHTML=''
          +'<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px"><b style="font-size:15px">'+s.ko+' 슬롯</b><span id="seX" style="cursor:pointer;color:var(--ink-faint);font-size:18px">✕</span></div>'
          +'<div style="font-size:11px;color:var(--ink-faint);margin-bottom:6px">보유 아이템 · 눌러서 장착</div>'
          +'<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px">'+cards+'</div>'
          +'<div style="height:1px;background:var(--line);margin:4px 0 12px"></div>'
          +'<div style="font-size:11px;color:var(--ink-faint);margin-bottom:6px">새로 만들기 (목록에 추가)</div>'
          +'<textarea id="seP" placeholder="예: 둥근 파란 눈, 반짝이는" style="width:100%;box-sizing:border-box;height:44px;border:1px solid var(--line);border-radius:10px;padding:8px;font-size:13px;resize:none"></textarea>'
          +'<div id="seDrop" style="margin-top:8px;border:1.5px dashed var(--line);border-radius:10px;padding:9px;text-align:center;font-size:12px;color:var(--ink-faint);cursor:pointer">참고 이미지(선택) 드래그/클릭</div>'
          +'<div id="seStatus" style="font-size:12px;color:var(--ink-soft);min-height:16px;margin-top:8px"></div>'
          +'<div style="display:flex;gap:8px;margin-top:8px"><button id="seGen" class="btn btn-primary" style="flex:1">✨ AI로 생성</button><button id="seUp" class="btn btn-ghost" style="flex:1">📁 업로드</button></div>';
        setRefLabel();
        document.getElementById('seX').onclick=closeEditor;
        Array.prototype.forEach.call(box.querySelectorAll('.seCard'), function(c){ c.onclick=function(e){
          if(e.target.classList.contains('seDel')){ e.stopPropagation(); var did=e.target.getAttribute('data-del');
            if(window.haroo&&window.haroo.removeItem) window.haroo.removeItem(id, did).then(function(d){ INV={items:(d&&d.items)||{},equipped:(d&&d.equipped)||{}}; applyEquipped(id); render(); }); return; }
          var eq=c.getAttribute('data-eq'); INV.equipped[id]= (eq==='builtin'?undefined:eq); if(window.haroo&&window.haroo.equip) window.haroo.equip(id, eq); applyEquipped(id); render(); }; });
        var drop=document.getElementById('seDrop');
        drop.onclick=function(){ var inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.onchange=function(){ var f=inp.files[0]; if(f) fileToB64(f, function(b){ refB64=b; setRefLabel(); }); }; inp.click(); };
        drop.addEventListener('dragover', function(e){ e.preventDefault(); drop.style.borderColor='var(--brand,#f06)'; });
        drop.addEventListener('dragleave', function(){ drop.style.borderColor='var(--line)'; });
        drop.addEventListener('drop', function(e){ e.preventDefault(); drop.style.borderColor='var(--line)'; var f=e.dataTransfer.files[0]; if(f) fileToB64(f, function(b){ refB64=b; setRefLabel(); }); });
        var stt=document.getElementById('seStatus');
        function addAndEquip(b64){ var nm=s.ko+' '+(itemsOf(id).length+1);
          if(!window.haroo||!window.haroo.addItem) return;
          window.haroo.addItem(id, nm, b64, true).then(function(d){ INV={items:(d&&d.items)||{},equipped:(d&&d.equipped)||{}}; applyEquipped(id); refB64=null; render(); }); }
        document.getElementById('seGen').onclick=function(){
          var prompt=(document.getElementById('seP').value||'').trim();
          if(!prompt && !refB64){ stt.textContent='텍스트를 적거나 참고 이미지를 올려줘'; return; }
          stt.innerHTML='<span class="haru-spin"></span> 생성 중… (최대 1분)';
          if(!window.haroo||!window.haroo.genPart){ stt.textContent='생성 기능을 쓸 수 없어요'; return; }
          window.haroo.genPart(id, prompt, refB64).then(function(r){
            if(!r||!r.ok){ stt.textContent='실패: '+((r&&r.error)||'오류'); return; }
            stt.innerHTML='<span class="haru-spin"></span> 다듬는 중…';
            processPart(r.b64).then(function(clean){ addAndEquip(clean); stt.textContent='완성! 목록에 추가하고 장착했어요 ✨'; });
          }).catch(function(e){ stt.textContent='오류: '+e; });
        };
        document.getElementById('seUp').onclick=function(){ var inp=document.createElement('input'); inp.type='file'; inp.accept='image/*';
          inp.onchange=function(){ var f=inp.files[0]; if(f) fileToB64(f, function(b){ addAndEquip(b); }); }; inp.click(); };
      }
      render();
    }

    function initParts(){ captureOrig(); buildRing();
      if(window.haroo&&window.haroo.getInventory){ window.haroo.getInventory().then(function(d){ INV={items:(d&&d.items)||{},equipped:(d&&d.equipped)||{}};
        SLOTS.forEach(function(s){ applyEquipped(s.id); }); buildRing(); updateRing(); }); } }
    // 설정창 열릴 때 링 보장 (패시브 — 클릭 처리 안 건드림)
    document.addEventListener('click', function(){ setTimeout(function(){ buildRing(); updateRing(); }, 80); }, false);
    initParts();
  })();

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
    tempRaise(8000); // 첫 실행 8초만 앞에 → 후 가라앉음
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
    pendingAlert = false; /* 알림으로 앞으로 나오지 않음 */
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
ipcMain.on('haroo:wake', function () { /* 클릭으로 앞에 안 나옴 */ });
ipcMain.on('haroo:ui-open', function () {
  winOpen = true;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (win && !win.isDestroyed()) {
    actionMode = true;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(false);   // 창 열림 동안엔 전체 클릭 가능 (hit-test 끔)
    win.show(); win.focus();
    if (win.webContents) win.webContents.send('haroo:action-mode', true);
  }
});
ipcMain.on('haroo:ui-closed', function () {
  winOpen = false;
  exitAction(); // 창 닫히면 바로 가라앉음
});
// 건드림/드래그 보고 → 10초 타이머 갱신
ipcMain.on('haroo:activity', function () { /* idle 로직 제거 */ });
// 알림 발생 시 액션 타임으로 깨우기 (미래 AI 알림 연결점 · 풀스크린이면 자동 보류)
ipcMain.on('haroo:alert', function () { /* 알림으로 앞에 안 나옴 */ });

/* ---- 더블클릭 → 중앙 채팅창 (별도 창 · 현재 목 UI) ----
 * 채팅창이 떠 있는 동안 하루는 액션 타임 유지(가라앉지 않음). */
function openChat() {
  raiseTop(true); // 채팅 열림 → 앞으로
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
    webPreferences: {
      preload: path.join(__dirname, 'chat-preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  });
  chatWin.setAlwaysOnTop(true, 'screen-saver'); // 채팅창은 열려있는 동안 항상 위
  chatWin.loadFile(CHAT);
  chatWin.once('ready-to-show', function () { chatWin.show(); chatWin.focus(); });
  chatOpen = true;
  refreshIdle(); // chatOpen=true 라 타이머 해제 → 안 가라앉음
  chatWin.on('closed', function () {
    chatWin = null; chatOpen = false;
    exitAction(); // 채팅 닫히면 가라앉음
  });
}
ipcMain.on('haroo:open-chat', function () { openChat(); });
ipcMain.handle('haroo:get-lang', function () { return store.get('lang') || 'en'; });
ipcMain.on('haroo:set-lang', function (e, l) { if (l === 'en' || l === 'ko') store.set('lang', l); });
ipcMain.handle('haroo:toggle-chat', function () {
  if (chatWin && !chatWin.isDestroyed()) { chatWin.close(); return false; }
  openChat(); return true;
});
ipcMain.handle('haroo:chat-state', function () { return !!(chatWin && !chatWin.isDestroyed()); });
ipcMain.on('haroo:quit', function () { app.quit(); });
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
    { label: '하루 부르기  (Ctrl+Alt+H)', click: function () { tempRaise(8000); } },
    { type: 'separator' },
    { label: '캐릭터 보이기', click: function () { if (win) win.showInactive(); sendToRenderer('show'); } },
    { label: '캐릭터 숨기기', click: function () { sendToRenderer('hide'); } },
    { type: 'separator' },
    { label: '대시보드 열기', click: function () { if (win) win.showInactive(); sendToRenderer('dashboard'); } },
    { type: 'separator' },
    { label: '종료', click: function () { app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', function () { if (win) win.showInactive(); sendToRenderer('dashboard'); });
}

/* ============================================================
 *  생명주기
 * ============================================================ */
app.whenReady().then(function () {
  createWindow();
  buildTray();
  // 전역 단축키: 어디서든 하루를 액션 타임으로 부름
  let ok = globalShortcut.register(HOTKEY, function () { tempRaise(8000); });
  if (!ok) { // 다른 앱이 Ctrl+Alt+H 를 이미 쓰면 대체키 시도
    ok = globalShortcut.register(HOTKEY_FALLBACK, function () { tempRaise(8000); });
  }
});

// 오버레이 펫이라 창을 닫아도 트레이로 살아있게 유지
app.on('window-all-closed', function () {});
app.on('before-quit', function () {
  globalShortcut.unregisterAll();
  if (tray) { tray.destroy(); tray = null; }
});
