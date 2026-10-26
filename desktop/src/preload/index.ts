import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../shared/types.js';
import type { SpeechEvent } from '../shared/speech-events.js';
import type { AIState, AppState, ChatState, DesktopAPI } from '../shared/types.js';

const api: DesktopAPI = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on(CHANNELS.state, listener);
    return () => ipcRenderer.removeListener(CHANNELS.state, listener);
  },
  openChat: () => ipcRenderer.invoke(CHANNELS.chat),
  openSettings: () => ipcRenderer.invoke(CHANNELS.settings),
  hideWindow: () => ipcRenderer.invoke(CHANNELS.hide),
  welcome: () => ipcRenderer.invoke(CHANNELS.welcome),
  setPaused: paused => ipcRenderer.invoke(CHANNELS.pause, paused),
  saveSettings: settings => ipcRenderer.invoke(CHANNELS.save, settings),
  resetPosition: () => ipcRenderer.invoke(CHANNELS.reset),
  setInteractive: interactive => ipcRenderer.send(CHANNELS.interactive, interactive),
  sendMessage: text => ipcRenderer.invoke(CHANNELS.send, text),
  getMessages: () => ipcRenderer.invoke(CHANNELS.messages),
  onChat: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ChatState) => callback(state);
    ipcRenderer.on(CHANNELS.chatState, listener);
    return () => ipcRenderer.removeListener(CHANNELS.chatState, listener);
  },
  stopReply: () => ipcRenderer.invoke(CHANNELS.stop),
  getAI: () => ipcRenderer.invoke(CHANNELS.ai),
  onAI: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: AIState) => callback(state);
    ipcRenderer.on(CHANNELS.aiState, listener);
    return () => ipcRenderer.removeListener(CHANNELS.aiState, listener);
  },
  checkAI: () => ipcRenderer.invoke(CHANNELS.checkAI),
  selectModel: model => ipcRenderer.invoke(CHANNELS.model, model),
  setAIMode: mode => ipcRenderer.invoke(CHANNELS.aiMode, mode),
  saveCloudConfig: config => ipcRenderer.invoke(CHANNELS.cloudConfig, config),
  fetchCloudModels: config => ipcRenderer.invoke(CHANNELS.fetchCloudModels, config),
  detectProvider: apiKey => ipcRenderer.invoke(CHANNELS.detectProvider, apiKey),
  testCloud: config => ipcRenderer.invoke(CHANNELS.testCloud, config),
  testFeature: feature => ipcRenderer.invoke(CHANNELS.testFeature, feature),
  playSpeech: payload => ipcRenderer.invoke(CHANNELS.playSpeech, payload),
  setVoiceActive: (active, target) => ipcRenderer.invoke(CHANNELS.setVoiceActive, { active, target }),
  setIsSpeaking: speaking => ipcRenderer.invoke(CHANNELS.setIsSpeaking, speaking),
  emitSpeechEvent: event => ipcRenderer.send(CHANNELS.speechEvent, event),
  onSpeechEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: SpeechEvent) => callback(event);
    ipcRenderer.on(CHANNELS.speechBroadcast, listener);
    return () => ipcRenderer.removeListener(CHANNELS.speechBroadcast, listener);
  },
  transcribeAudio: (base64Audio, mimeType, language, hint) => ipcRenderer.invoke(CHANNELS.transcribeAudio, { base64Audio, mimeType, language, hint }),
  playAudio: dataUri => ipcRenderer.invoke(CHANNELS.playAudio, dataUri),
  clearMessages: () => ipcRenderer.invoke(CHANNELS.clear),
  quit: () => ipcRenderer.invoke(CHANNELS.quit),
};
contextBridge.exposeInMainWorld('companion', api);
