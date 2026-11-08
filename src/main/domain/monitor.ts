// 可租周期与通知判定（业务流程 §5）：首次/导入/重新开启只建立基线；未知不抹掉最后可信状态；
// 同一可租周期只通知一次；可租 → 不可租 → 可租为新周期；周期与可信状态持久化，重启不重放。
import type { AccountStatus } from '../../shared/status';

export interface MonitorState {
  trustedStatus: AccountStatus | null;
  trustedAt: number | null;
  displayStatus: AccountStatus;
  displayError: string | null;
  checkedAt: number | null;
  expireTimeMs: number | null;
  lastChangeAt: number | null;
  lastChangeFrom: AccountStatus | null;
  lastChangeTo: AccountStatus | null;
  cycleId: number;
  notifiedCycle: number;
  baselinePending: boolean;
  unseen: boolean;
}

export type Observation =
  | { ok: true; status: AccountStatus; expireTimeMs: number | null }
  | { ok: false; error: string };

export interface ObserveResult {
  next: MonitorState;
  notify: boolean;
}

export function observe(prev: MonitorState, obs: Observation, now: number): ObserveResult {
  if (!obs.ok || obs.status === 'UNKNOWN') {
    return {
      next: {
        ...prev,
        displayStatus: 'UNKNOWN',
        displayError: obs.ok ? '平台返回的状态无法识别' : obs.error,
        checkedAt: now,
      },
      notify: false,
    };
  }
  const status = obs.status;
  const next: MonitorState = {
    ...prev,
    displayStatus: status,
    displayError: null,
    checkedAt: now,
    expireTimeMs: obs.expireTimeMs,
    trustedStatus: status,
    trustedAt: now,
  };
  const previous = prev.trustedStatus;
  if (previous !== status) {
    next.lastChangeAt = now;
    next.lastChangeFrom = previous;
    next.lastChangeTo = status;
  }
  if (prev.baselinePending || previous == null) {
    next.baselinePending = false;
    if (status === 'AVAILABLE' && previous !== 'AVAILABLE') {
      // 基线时已处于可租：记为一个已“处理”的周期，不通知
      next.cycleId = prev.cycleId + 1;
      next.notifiedCycle = next.cycleId;
    }
    return { next, notify: false };
  }
  if (status === 'AVAILABLE' && previous !== 'AVAILABLE') {
    next.cycleId = prev.cycleId + 1;
    const notify = next.notifiedCycle < next.cycleId;
    next.notifiedCycle = next.cycleId;
    next.unseen = true;
    return { next, notify };
  }
  return { next, notify: false };
}

export function initialMonitorState(): MonitorState {
  return {
    trustedStatus: null,
    trustedAt: null,
    displayStatus: 'UNKNOWN',
    displayError: null,
    checkedAt: null,
    expireTimeMs: null,
    lastChangeAt: null,
    lastChangeFrom: null,
    lastChangeTo: null,
    cycleId: 0,
    notifiedCycle: 0,
    baselinePending: true,
    unseen: false,
  };
}
