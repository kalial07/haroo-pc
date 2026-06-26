'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harooChat', {
  // API 키 연결 상태 (값은 안 받고 boolean 만)
  getKeyStatus: function () { return ipcRenderer.invoke('haroo:get-key-status'); },
  // 'API 연결' 버튼 → 캐릭터 설정의 대화 AI 연결 열기
  openAiSettings: function () { ipcRenderer.send('haroo:open-ai-settings'); }
});
