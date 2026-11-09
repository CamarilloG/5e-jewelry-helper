import { describe, expect, it, vi } from 'vitest';
import { nullLogger } from '../src/main/logger';
import {
  type UpdaterDriver,
  UpdateService,
  updateErrorMessage,
} from '../src/main/services/update-service';
import type { UpdateView } from '../src/shared/dto';
import { ipcInputs } from '../src/shared/ipc';

function setup(driver: Partial<UpdaterDriver> | null, busy = false) {
  const changes: UpdateView[] = [];
  const requestInstall = vi.fn();
  const full: UpdaterDriver | null = driver && {
    check: async () => ({ version: '1.0.4', notes: '说明' }),
    download: async (progress) => progress(100),
    quitAndInstall: vi.fn(),
    ...driver,
  };
  const service = new UpdateService({
    driver: full,
    currentVersion: '1.0.3',
    isBusy: () => busy,
    requestInstall,
    onChange: (v) => changes.push(v),
    logger: nullLogger,
  });
  return { service, changes, requestInstall };
}

const err = (message: string, code?: string) => Object.assign(new Error(message), { code });

describe('在线更新服务', () => {
  it('手动流程：检查、下载、安装依次流转，且不自动下载', async () => {
    const download = vi.fn(async (p: (n: number) => void) => {
      p(10.6);
      p(10.9);
      p(100);
    });
    const { service, changes, requestInstall } = setup({ download });
    expect((await service.check(true)).phase).toBe('AVAILABLE');
    expect(download).not.toHaveBeenCalled();
    expect(requestInstall).not.toHaveBeenCalled();
    expect((await service.download()).phase).toBe('DOWNLOADED');
    // 同一整数进度只通知一次
    expect(changes.filter((c) => c.phase === 'DOWNLOADING' && c.percent === 10)).toHaveLength(1);
    expect(service.install()).toEqual({ ok: true });
    expect(requestInstall).toHaveBeenCalledOnce();
  });

  it('没有新版本时显示已是最新', async () => {
    const { service } = setup({ check: async () => null });
    const view = await service.check(true);
    expect(view.phase).toBe('LATEST');
    expect(view.version).toBeNull();
  });

  it('启动自动检查失败不打扰，手动检查失败给出中文原因', async () => {
    const check = async () => {
      throw err('net::ERR_INTERNET_DISCONNECTED');
    };
    const auto = setup({ check });
    expect((await auto.service.check(false)).phase).toBe('IDLE');
    const manual = setup({ check });
    const view = await manual.service.check(true);
    expect(view.phase).toBe('ERROR');
    expect(view.errorDuring).toBe('CHECK');
    expect(view.error).toContain('无法连接更新服务器');
  });

  it('校验失败拒绝安装，可重新下载', async () => {
    let fail = true;
    const { service, requestInstall } = setup({
      download: async () => {
        if (fail) throw err('sha512 checksum mismatch', 'ERR_CHECKSUM_MISMATCH');
      },
    });
    await service.check(true);
    const failed = await service.download();
    expect(failed.phase).toBe('ERROR');
    expect(failed.errorDuring).toBe('DOWNLOAD');
    expect(failed.error).toContain('校验失败');
    expect(service.install().ok).toBe(false);
    expect(requestInstall).not.toHaveBeenCalled();
    fail = false;
    expect((await service.download()).phase).toBe('DOWNLOADED');
  });

  it('出码进行中禁止安装', async () => {
    const { service, requestInstall } = setup({}, true);
    await service.check(true);
    await service.download();
    const result = service.install();
    expect(result.ok).toBe(false);
    expect(requestInstall).not.toHaveBeenCalled();
  });

  it('未下载完成不能安装，下载中不重复检查', async () => {
    let finish = () => {};
    const check = vi.fn(async () => ({ version: '1.0.4', notes: null }));
    const { service } = setup({
      check,
      download: () => new Promise<void>((resolve) => (finish = resolve)),
    });
    expect(service.install().ok).toBe(false);
    await service.check(true);
    const pending = service.download();
    await service.check(true);
    expect(check).toHaveBeenCalledOnce();
    finish();
    await pending;
  });

  it('启动检查延迟执行，退出时取消', async () => {
    vi.useFakeTimers();
    try {
      const check = vi.fn(async () => null);
      const a = setup({ check });
      a.service.scheduleStartupCheck(1000);
      a.service.stop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(check).not.toHaveBeenCalled();
      a.service.scheduleStartupCheck(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(check).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('不支持的环境不发起检查', async () => {
    const { service } = setup(null);
    expect(service.view().supported).toBe(false);
    expect((await service.check(true)).phase).toBe('IDLE');
  });

  it('错误信息不泄露原始地址', () => {
    const raw = 'Cannot find latest.yml in https://example.test/a, HttpError: 404';
    expect(updateErrorMessage(err(raw))).not.toContain('example.test');
    expect(updateErrorMessage(err('boom'))).toContain('更新失败');
  });

  it('更新相关 IPC 都不接受参数', () => {
    for (const channel of [
      'update.state',
      'update.check',
      'update.download',
      'update.install',
    ] as const) {
      expect(ipcInputs[channel].safeParse({ url: 'https://evil.test' }).success).toBe(false);
      expect(ipcInputs[channel].safeParse(undefined).success).toBe(true);
    }
  });
});
