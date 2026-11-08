// 原生通知与一次性通知意图（业务流程 §5，技术选型 §6）：单账号“查看/一键出码”；同轮多账号合并为一条，只有“查看”。
import { createHash, randomBytes } from 'node:crypto';
import { type ActivationAction, activationUrl, escapeXml } from '../domain/activation';
import type { Logger } from '../logger';
import type { DbClient } from '../storage/client';

export const INTENT_TTL = 10 * 60 * 1000;

export interface ToastSpec {
  xml: string;
}

export interface Notifier {
  supported(): boolean;
  /** 提交通知；返回是否已提交（不代表用户看到）。 */
  show(spec: ToastSpec): boolean;
}

export interface AvailableAccount {
  accountNo: string;
  tagline: string;
  priceText: string | null;
  imagePath: string | null;
  presetDigest: string | null;
}

export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

export function presetDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16);
}

export function buildToastXml(opts: {
  title: string;
  lines: string[];
  launch: string;
  image: string | null;
  actions: { label: string; url: string }[];
  silent: boolean;
}): string {
  const image = opts.image
    ? `<image placement="appLogoOverride" src="${escapeXml(opts.image)}"/>`
    : '';
  const texts = [opts.title, ...opts.lines].map((t) => `<text>${escapeXml(t)}</text>`).join('');
  const actions = opts.actions
    .map(
      (a) =>
        `<action content="${escapeXml(a.label)}" activationType="protocol" arguments="${escapeXml(a.url)}"/>`,
    )
    .join('');
  return `<toast activationType="protocol" launch="${escapeXml(opts.launch)}"><visual><binding template="ToastGeneric">${texts}${image}</binding></visual>${
    actions ? `<actions>${actions}</actions>` : ''
  }<audio ${opts.silent ? 'silent="true"' : 'src="ms-winsoundevent:Notification.Default"'}/></toast>`;
}

export class NotificationService {
  constructor(
    private readonly db: DbClient,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  private async intent(
    profileId: string,
    action: ActivationAction,
    accountNo: string | null,
    digest: string | null,
  ) {
    const nonce = newNonce();
    const now = this.now();
    await this.db.call('intents.create', {
      row: {
        nonce,
        profile_id: profileId,
        account_no: accountNo,
        action,
        preset_digest: digest,
        created_at: now,
        expires_at: now + INTENT_TTL,
        consumed_at: null,
      },
    });
    return activationUrl(action, nonce);
  }

  /** 发送“变为可租”通知；返回是否已提交给系统。 */
  async notifyAvailable(
    profileId: string,
    accounts: AvailableAccount[],
    opts: { enabled: boolean; sound: boolean },
  ): Promise<boolean> {
    if (accounts.length === 0 || !opts.enabled) return false;
    if (!this.notifier.supported()) {
      this.logger.info('notify.skip', { reason: 'UNSUPPORTED' });
      return false;
    }
    let xml: string;
    if (accounts.length === 1) {
      const a = accounts[0] as AvailableAccount;
      const view = await this.intent(profileId, 'view', a.accountNo, null);
      const checkout = await this.intent(profileId, 'checkout', a.accountNo, a.presetDigest);
      const body = [a.accountNo, a.tagline, a.priceText].filter(Boolean).join(' · ');
      xml = buildToastXml({
        title: '收藏账号可租了',
        lines: [body, '先到先得，工具不代抢'],
        launch: view,
        image: a.imagePath,
        actions: [
          { label: '查看', url: view },
          { label: '一键出码', url: checkout },
        ],
        silent: !opts.sound,
      });
    } else {
      const list = await this.intent(profileId, 'list', null, null);
      const head = accounts
        .slice(0, 3)
        .map((a) => a.accountNo)
        .join('、');
      xml = buildToastXml({
        title: `${accounts.length} 个收藏账号可租了`,
        lines: [accounts.length > 3 ? `${head} 等` : head],
        launch: list,
        image: null,
        actions: [{ label: '查看', url: list }],
        silent: !opts.sound,
      });
    }
    const shown = this.notifier.show({ xml });
    this.logger.info('notify.submit', {
      count: accounts.length,
      state: shown ? 'SUBMITTED' : 'FAILED',
    });
    return shown;
  }

  /** 消费通知 nonce；无效、过期、跨用户或重放只能打开收藏页。 */
  async consume(nonce: string, profileId: string | null) {
    return this.db.call('intents.consume', { nonce, profileId, now: this.now() });
  }
}
