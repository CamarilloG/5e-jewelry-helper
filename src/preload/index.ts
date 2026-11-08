// 白名单 IPC 桥：只暴露具名方法与具名事件，不暴露 ipcRenderer、任意频道、文件或 shell 能力。
import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import { MAIN_EVENT_TYPES, type MainEvent } from '../shared/dto';
import { IPC_CHANNELS, type IpcChannel, type IpcResult } from '../shared/ipc';
import type { JewelryApi } from './api';

const allowedChannels = new Set<string>(IPC_CHANNELS);
const allowedEvents = new Set<string>(MAIN_EVENT_TYPES);

async function invoke(channel: IpcChannel, input?: unknown): Promise<unknown> {
  if (!allowedChannels.has(channel)) throw new Error('IPC_CHANNEL_REJECTED');
  const result = (await ipcRenderer.invoke(channel, input)) as IpcResult<unknown>;
  if (result.ok) return result.value;
  const error = new Error(result.error.message);
  error.name = result.error.code;
  throw error;
}

const methods: Record<string, (input?: unknown) => Promise<unknown>> = {};
for (const channel of IPC_CHANNELS) methods[channel] = (input?: unknown) => invoke(channel, input);

const api: JewelryApi = {
  methods: Object.freeze(methods) as unknown as JewelryApi['methods'],
  on(type, listener) {
    if (!allowedEvents.has(type)) throw new Error('IPC_EVENT_REJECTED');
    const handler = (_event: IpcRendererEvent, payload: unknown) =>
      (listener as (p: unknown) => void)(payload);
    ipcRenderer.on(`event:${type}`, handler);
    return () => {
      ipcRenderer.removeListener(`event:${type}`, handler);
    };
  },
};

contextBridge.exposeInMainWorld('jewelry', Object.freeze(api));

export type { MainEvent };
