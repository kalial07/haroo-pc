'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let trayCb = null;
let reflowCb = null;

ipcRenderer.on('haroo:tray', function (e, cmd) { if (trayCb) trayCb(cmd); });
ipcRenderer.on('haroo:reflow', function () { if (reflowCb) reflowCb(); });

contextBridge.exposeInMainWorld('haroo', {
  // 클릭 통과 토글: v=true 면 창이 이벤트 수신, false 면 바탕화면으로 통과
  setInteractive: function (v) { ipcRenderer.send('haroo:set-interactive', !!v); },
  // 캐릭터 위치 저장/복원 (작업영역 가로 비율)
  savePos: function (p) { ipcRenderer.send('haroo:save-pos', p); },
  loadPos: function () { return ipcRenderer.invoke('haroo:load-pos'); },
  // 트레이 명령 수신 (show / hide / dashboard)
  onTrayCommand: function (cb) { trayCb = cb; },
  // 해상도/모니터 변경 알림
  onReflow: function (cb) { reflowCb = cb; },
  ready: function () { ipcRenderer.send('haroo:ready'); }
});
