// 登录态与身份：读取 → 本地到期预判 → 官方 user/info/get 确认；凭证只驻主进程内存（技术选型 §4，业务流程 §1）。
import type { AuthPhase, AuthView } from '../../shared/dto';
import type { Logger } from '../logger';
import type { PlatformApi } from '../platform/api';
import type { CredentialSource } from '../platform/client';
import { PlatformError } from '../platform/errors';
import { Priority } from '../platform/queue';
import { type CredentialReader, jwtExpiryMs } from './reader-process';

export interface AuthEvents {
  /** 身份确认成功；previous 为上一个已确认的身份（可能与当前相同） */
  confirmed(profileId: string, previous: string | null): void;
  /** 运行中失效或读取后无法使用 */
  lost(phase: AuthPhase): void;
}

const DAY = 86_400_000;

export class AuthService implements CredentialSource {
  private secret: string | null = null;
  private phase: AuthPhase = 'INIT';
  private runtimeExpired = false;
  private expiresAt: number | null = null;
  private readAt: number | null = null;
  private errorSummary: string | null = null;
  private profile: string | null = null;
  private restrictions: AuthView['restrictions'] = null;
  private reloading: Promise<void> | null = null;
  private api: PlatformApi | null = null;

  constructor(
    private readonly reader: CredentialReader,
    private readonly events: AuthEvents,
    private readonly logger: Logger,
    private dataDir: { path: string; custom: boolean },
    private readonly now: () => number = Date.now,
  ) {}

  attach(api: PlatformApi) {
    this.api = api;
  }

  credential(): string | null {
    return this.phase === 'OK' || this.phase === 'CHECKING' ? this.secret : null;
  }

  profileId(): string | null {
    return this.phase === 'OK' ? this.profile : null;
  }

  lastProfileId(): string | null {
    return this.profile;
  }

  setDataDir(dir: { path: string; custom: boolean }) {
    this.dataDir = dir;
  }

  view(): AuthView {
    return {
      phase: this.phase,
      runtimeExpired: this.runtimeExpired,
      daysLeft:
        this.phase === 'OK' && this.expiresAt != null
          ? Math.max(0, Math.ceil((this.expiresAt - this.now()) / DAY))
          : null,
      readAt: this.readAt,
      dataDir: this.dataDir.path,
      customDir: this.dataDir.custom,
      errorSummary: this.errorSummary,
      restrictions: this.restrictions,
    };
  }

  reload(): Promise<void> {
    if (!this.reloading) {
      this.reloading = this.doReload().finally(() => {
        this.reloading = null;
      });
    }
    return this.reloading;
  }

  private setLost(phase: AuthPhase, summary: string | null) {
    this.secret = null;
    this.phase = phase;
    this.errorSummary = summary;
    this.restrictions = null;
    this.events.lost(phase);
  }

  private async doReload(): Promise<void> {
    const started = this.now();
    const outcome = await this.reader(this.dataDir.path);
    this.readAt = this.now();
    this.logger.info('auth.read', { state: outcome.state, ms: this.now() - started });
    if (outcome.state === 'NO_CLIENT') return this.setLost('NO_CLIENT', null);
    if (outcome.state === 'NO_LOGIN') return this.setLost('NO_LOGIN', null);
    if (outcome.state === 'READ_FAILED')
      return this.setLost('READ_FAILED', `读取失败（${outcome.reason}）`);
    const expiry = jwtExpiryMs(outcome.credential);
    if (expiry != null && expiry <= this.now()) return this.setLost('EXPIRED', null);
    this.secret = outcome.credential;
    this.expiresAt = expiry;
    this.phase = 'CHECKING';
    if (!this.api) return this.setLost('READ_FAILED', '内部错误');
    try {
      const info = await this.api.userInfo({ priority: Priority.USER });
      let agreementDone = false;
      try {
        agreementDone = (await this.api.authInfo({ priority: Priority.USER })).agreementDone;
      } catch (error) {
        if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') throw error;
      }
      const previous = this.profile;
      this.profile = info.profileId;
      this.phase = 'OK';
      this.runtimeExpired = false;
      this.errorSummary = null;
      this.restrictions = {
        certified: info.certified,
        banned: info.banned,
        maintenance: info.maintenance,
        agreementDone,
      };
      this.events.confirmed(info.profileId, previous);
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') {
        return this.setLost('EXPIRED', null);
      }
      if (error instanceof PlatformError && error.code === 'CONTRACT_CHANGED') {
        return this.setLost('READ_FAILED', '平台接口可能已变更');
      }
      return this.setLost('NETWORK', '无法连接 5E 平台确认登录态，请检查网络后重试');
    }
  }

  /** 平台请求返回业务/HTTP 401：暂停平台任务，保留本地数据。 */
  markExpired() {
    if (this.phase !== 'OK') return;
    this.runtimeExpired = true;
    this.setLost('EXPIRED', null);
  }

  /** 出码预检时刷新用户限制与协议状态。 */
  async refreshRestrictions(): Promise<NonNullable<AuthView['restrictions']>> {
    if (!this.api) throw new Error('NO_API');
    const info = await this.api.userInfo({ priority: Priority.CHECKOUT });
    if (this.profile && info.profileId !== this.profile) {
      throw new PlatformError('AUTH_EXPIRED', 'PROFILE_CHANGED');
    }
    const agreement = await this.api.authInfo({ priority: Priority.CHECKOUT });
    this.restrictions = {
      certified: info.certified,
      banned: info.banned,
      maintenance: info.maintenance,
      agreementDone: agreement.agreementDone,
    };
    return this.restrictions;
  }
}
