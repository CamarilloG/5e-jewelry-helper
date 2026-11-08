import type { MainEvent } from '../shared/dto';
import type { IpcChannel, IpcInput, IpcOutputs } from '../shared/ipc';

type EventPayload<T extends MainEvent['type']> = Extract<MainEvent, { type: T }>['payload'];

export interface JewelryApi {
  /** 每个白名单频道一个具名方法 */
  methods: {
    readonly [C in IpcChannel]: (
      ...input: IpcInput<C> extends undefined ? [] : [IpcInput<C>]
    ) => Promise<IpcOutputs[C]>;
  };
  on<T extends MainEvent['type']>(
    type: T,
    listener: (payload: EventPayload<T>) => void,
  ): () => void;
}

declare global {
  interface Window {
    jewelry: JewelryApi;
  }
}
