'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let trayCb = null;
let reflowCb = null;
let actionCb = null;

ipcRenderer.on('haroo:tray', function (e, cmd) { if (trayCb) trayCb(cmd); });
ipcRenderer.on('haroo:reflow', function () { if (reflowCb) reflowCb(); });
let openAiCb = null;
ipcRenderer.on('haroo:open-ai-settings', function () { if (openAiCb) openAiCb(); });
ipcRenderer.on('haroo:action-mode', function (e, on) { if (actionCb) actionCb(!!on); });

contextBridge.exposeInMainWorld('haroo', {
  // 클릭 통과 토글: v=true 면 창이 이벤트 수신, false 면 바탕화면으로 통과 (액션 타임에서만 유효)
  setInteractive: function (v) { ipcRenderer.send('haroo:set-interactive', !!v); },
  // 캐릭터 위치 저장/복원 (작업영역 가로 비율)
  savePos: function (p) { ipcRenderer.send('haroo:save-pos', p); },
  loadPos: function () { return ipcRenderer.invoke('haroo:load-pos'); },
  // 트레이 명령 수신 (show / hide / dashboard)
  onTrayCommand: function (cb) { trayCb = cb; },
  // 해상도/모니터 변경 알림
  onReflow: function (cb) { reflowCb = cb; },
  // 레이어 상태 변경 수신 (true=액션 타임, false=바탕화면 레이어)
  onActionMode: function (cb) { actionCb = cb; },
  // 건드림/드래그 보고 → 액션 타임 10초 타이머 갱신
  activity: function () { ipcRenderer.send('haroo:activity'); },
  // 보이는 하루를 클릭 → 액션 타임으로 깨우기
  wake: function () { ipcRenderer.send('haroo:wake'); },
  // 하루 더블클릭 → 중앙 채팅창 열기
  openChat: function () { ipcRenderer.send('haroo:open-chat'); },
  // 알림 발생 → 액션 타임으로 깨우기 요청 (풀스크린이면 자동 보류)
  alert: function () { ipcRenderer.send('haroo:alert'); },
  saveAiKey: function (provider, key) { return ipcRenderer.invoke('haroo:save-key', { provider: provider, key: key }); },
  aiKeyStatus: function () { return ipcRenderer.invoke('haroo:get-key-status'); },
  setActiveAi: function (provider) { ipcRenderer.send('haroo:set-active-ai', { provider: provider }); },
  setPersona: function (p) { ipcRenderer.send('haroo:set-persona', p); },
  onOpenAiSettings: function (cb) { openAiCb = cb; },
  ready: function () { ipcRenderer.send('haroo:ready'); }
});
