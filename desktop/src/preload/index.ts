import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from '../shared/types.js';
import type { SpeechEvent } from '../shared/speech-events.js';
import type { AIState, AppState, ChatState, DesktopAPI, ToolApprovalEvent } from '../shared/types.js';
import type { TasksView } from '../shared/tasks.js';

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
  saveSettings: (settings, source) => ipcRenderer.invoke(CHANNELS.save, { patch: settings, source }),
  resetPosition: () => ipcRenderer.invoke(CHANNELS.reset),
  setInteractive: interactive => ipcRenderer.send(CHANNELS.interactive, interactive),
  setCaptionVisible: visible => ipcRenderer.send(CHANNELS.caption, visible),
  onReminder: callback => {
    const listener = (_event: Electron.IpcRendererEvent, reminder: { text: string; late: boolean }) => callback(reminder);
    ipcRenderer.on(CHANNELS.reminderDue, listener);
    return () => ipcRenderer.removeListener(CHANNELS.reminderDue, listener);
  },
  sendMessage: (text, voice) => ipcRenderer.invoke(CHANNELS.send, voice === undefined ? text : { text, voice }),
  getMessages: () => ipcRenderer.invoke(CHANNELS.messages),
  onChat: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ChatState) => callback(state);
    ipcRenderer.on(CHANNELS.chatState, listener);
    return () => ipcRenderer.removeListener(CHANNELS.chatState, listener);
  },
  stopReply: options => ipcRenderer.invoke(CHANNELS.stop, options?.keepScreen === true ? { keepScreen: true } : undefined),
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
  setVoiceActive: (active, target, reason) => ipcRenderer.invoke(CHANNELS.setVoiceActive, { active, target, reason }),
  setIsSpeaking: speaking => ipcRenderer.invoke(CHANNELS.setIsSpeaking, speaking),
  emitSpeechEvent: event => ipcRenderer.send(CHANNELS.speechEvent, event),
  onSpeechEvent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: SpeechEvent) => callback(event);
    ipcRenderer.on(CHANNELS.speechBroadcast, listener);
    return () => ipcRenderer.removeListener(CHANNELS.speechBroadcast, listener);
  },
  transcribeAudio: (base64Audio, mimeType, language, hint) => ipcRenderer.invoke(CHANNELS.transcribeAudio, { base64Audio, mimeType, language, hint }),
  playAudio: dataUri => ipcRenderer.invoke(CHANNELS.playAudio, dataUri),
  getUsage: () => ipcRenderer.invoke(CHANNELS.usage),
  getUpdateNotice: () => ipcRenderer.invoke(CHANNELS.updateNotice),
  getKeyStorageInfo: () => ipcRenderer.invoke(CHANNELS.keyStorageInfo),
  clearSavedKeys: () => ipcRenderer.invoke(CHANNELS.clearKeys),
  getAzure: () => ipcRenderer.invoke(CHANNELS.azureGet),
  saveAzure: config => ipcRenderer.invoke(CHANNELS.azureSave, config),
  testAzure: sample => ipcRenderer.invoke(CHANNELS.azureTest, sample),
  sendScreen: payload => ipcRenderer.invoke(CHANNELS.sendScreen, payload),
  cancelScreen: () => ipcRenderer.invoke(CHANNELS.cancelScreen),
  screenConsent: granted => ipcRenderer.invoke(CHANNELS.screenConsent, granted === true),
  liveAwarenessConsent: granted => ipcRenderer.invoke(CHANNELS.liveAwarenessConsent, granted === true),
  clearMessages: () => ipcRenderer.invoke(CHANNELS.clear),
  quit: () => ipcRenderer.invoke(CHANNELS.quit),
  onToolApproval: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: ToolApprovalEvent) => callback(event);
    ipcRenderer.on(CHANNELS.toolApproval, listener);
    return () => ipcRenderer.removeListener(CHANNELS.toolApproval, listener);
  },
  getToolApprovals: () => ipcRenderer.invoke(CHANNELS.toolApprovals),
  respondToolApproval: (id, decision) => ipcRenderer.invoke(CHANNELS.toolApprovalReply, { id, decision }),
  stopAllTools: () => ipcRenderer.invoke(CHANNELS.toolsStopAll),
  getTasks: () => ipcRenderer.invoke(CHANNELS.tasksList),
  onTasks: callback => {
    const listener = (_event: Electron.IpcRendererEvent, view: TasksView) => callback(view);
    ipcRenderer.on(CHANNELS.tasksState, listener);
    return () => ipcRenderer.removeListener(CHANNELS.tasksState, listener);
  },
  addTaskText: text => ipcRenderer.invoke(CHANNELS.tasksAdd, text),
  taskAction: (id, action) => ipcRenderer.invoke(CHANNELS.tasksAct, { id, action }),
  getLocalWakeProfile: () => ipcRenderer.invoke(CHANNELS.localWakeGet),
  saveLocalWakeProfile: profile => ipcRenderer.invoke(CHANNELS.localWakeSave, profile),
  deleteLocalWakeProfile: () => ipcRenderer.invoke(CHANNELS.localWakeDelete),
};
contextBridge.exposeInMainWorld('companion', api);
