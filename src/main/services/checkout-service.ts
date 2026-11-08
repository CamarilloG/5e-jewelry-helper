// 出码状态机（业务流程 §6）：全局只允许一个活动尝试，从预检开始占用互斥；按钮、通知和详情入口共用同一入口。
// 创建请求只发送一次；响应丢失进入“创建结果确认中”；释放受理≠订单取消；本地归零≠平台超时；PAID 不可降级。
import { randomUUID } from 'node:crypto';
import type { CheckoutStartResult, CheckoutState, CheckoutView } from '../../shared/dto';
import { fenToDisplayYuan } from '../../shared/money';
import { RENT_META, type RentKind, slotOrderable } from '../../shared/rent';
import { AGREEMENT_VERSION } from '../../shared/settings';
import type { AuthService } from '../auth/auth-service';
import { payVerdict, REASON_TEXT } from '../domain/order-reasons';
import type { Logger } from '../logger';
import type { PlatformApi } from '../platform/api';
import { isCancelled, PlatformError, userMessage } from '../platform/errors';
import { Priority } from '../platform/queue';
import type { DbClient } from '../storage/client';
import type { AttemptRow } from '../storage/ops';
import type { AccountService } from './account-service';
import type { FavoritesService } from './favorites-service';
import { computeQuote, QUOTE_ERROR_TEXT } from './quote';

export const RECOVERY_LIMIT_MS = 5 * 60_000;
export const QUIT_WAIT_MS = 15_000;

export interface OrderParams {
  rentKind: RentKind;
  quantity: number;
  payChannel: 1 | 2;
  autoCoupon: boolean;
}

export interface StartInput {
  accountNo: string;
  params: OrderParams | null;
  source: 'DETAIL' | 'FAVORITE' | 'NOTIFICATION';
  /** 用户点击时界面展示的报价（元）；与刷新后的报价不一致即停止本次触发 */
  expectedAmountYuan?: string | null;
  expectedUnitYuan?: string | null;
}

export interface CheckoutDeps {
  api: PlatformApi;
  db: DbClient;
  accounts: AccountService;
  favorites: FavoritesService;
  auth: AuthService;
  profile: () => string | null;
  agreementVersion: () => Promise<string | null>;
  defaultPreset: () => Promise<{ payChannel: 1 | 2; autoCoupon: boolean }>;
  rateLimit: () => number;
  loadPaymentImage: (codeUrl: string) => Promise<string | null>;
  onChange: (view: CheckoutView | null) => void;
  onBusyChange: (busy: boolean) => void;
  logger: Logger;
  now?: () => number;
  mono?: () => number;
}

interface Runtime {
  attemptId: string;
  profileId: string;
  accountNo: string;
  state: CheckoutState;
  params: OrderParams | null;
  quote: {
    amountFen: string;
    originalFen: string;
    discountFen: string;
    couponApplied: boolean;
  } | null;
  paymentOrderId: string | null;
  deadlineMs: number | null;
  monoDeadline: number | null;
  paymentImage: string | null;
  imageError: boolean;
  releaseState: CheckoutView['releaseState'];
  reason: CheckoutView['reason'];
  lockRequested: boolean;
  createSent: boolean;
  cleanupDone: boolean;
  finished: boolean;
  cancelRequested: boolean;
  needsManualCheck: boolean;
  checkingSince: number | null;
  statusNote: string | null;
  traceId: string;
  createdAt: number;
  pollTimer: ReturnType<typeof setTimeout> | null;
  polling: boolean;
}

const BUSY_STATES: CheckoutState[] = [
  'CHECKING',
  'CREATING',
  'PENDING',
  'CREATE_UNKNOWN',
  'STATUS_UNKNOWN',
  'RELEASE_PENDING',
  'RELEASE_ACCEPTED',
  'RELEASE_UNKNOWN',
];

export class CheckoutService {
  private current: Runtime | null = null;
  private readonly now: () => number;
  private readonly mono: () => number;

  constructor(private readonly deps: CheckoutDeps) {
    this.now = deps.now ?? Date.now;
    this.mono = deps.mono ?? (() => performance.now());
  }

  // ---------- 查询 ----------

  view(): CheckoutView | null {
    const r = this.current;
    if (!r) return null;
    const remaining =
      r.monoDeadline != null && r.state === 'PENDING'
        ? Math.max(0, r.monoDeadline - this.mono())
        : null;
    const showCode =
      r.state === 'PENDING' && remaining != null && remaining > 0 && !r.cancelRequested;
    return {
      attemptId: r.attemptId,
      accountNo: r.accountNo,
      state: r.state,
      params: r.params,
      quote: r.quote
        ? {
            amountYuan: fenToDisplayYuan(r.quote.amountFen),
            originalYuan: fenToDisplayYuan(r.quote.originalFen),
            discountYuan: fenToDisplayYuan(r.quote.discountFen),
            couponApplied: r.quote.couponApplied,
          }
        : null,
      paymentImage: showCode ? r.paymentImage : null,
      imageError: r.imageError,
      deadlineMs: r.deadlineMs,
      remainingMs: remaining,
      statusText: this.statusText(r, remaining),
      reason: r.reason,
      releaseState: r.releaseState,
      finished: r.finished,
      canCancel:
        !r.finished &&
        ((r.state === 'CHECKING' && !r.cancelRequested) ||
          (r.state === 'PENDING' && !r.cancelRequested)),
      canRetry:
        r.finished &&
        (r.state === 'EXPIRED' || (r.state === 'REJECTED' && (r.reason?.retryable ?? false))),
      needsManualCheck: !r.finished && r.needsManualCheck,
      createdAt: r.createdAt,
    };
  }

  private statusText(r: Runtime, remaining: number | null): string {
    if (r.statusNote) return r.statusNote;
    switch (r.state) {
      case 'CHECKING':
        return r.cancelRequested ? '正在结束预检并清理可能的锁…' : '正在检查账号是否可下单…';
      case 'CREATING':
        return '正在创建订单…';
      case 'PENDING':
        if (r.cancelRequested) return '正在核对订单状态…';
        if (remaining != null && remaining <= 0) return '付款时间已到，正在核对订单状态…';
        if (!r.paymentImage && !r.imageError && r.monoDeadline == null)
          return '付款码未保存，请在 5E 客户端核对或申请取消';
        return '等待支付…';
      case 'CREATE_UNKNOWN':
        return '创建结果确认中，请到 5E 客户端核对订单';
      case 'STATUS_UNKNOWN':
        return '订单状态需在 5E 客户端核对';
      case 'RELEASE_PENDING':
        return '正在核对并申请释放账号…';
      case 'RELEASE_ACCEPTED':
        return '释放请求已受理，正在核对订单状态';
      case 'RELEASE_UNKNOWN':
        return '释放结果未确认，请到 5E 客户端核对';
      case 'PAID':
        return '支付成功，请回到 5E 客户端完成上号';
      case 'EXPIRED':
        return '平台已确认支付超时';
      case 'REJECTED':
        return r.reason?.text ?? '无法下单';
      case 'PREFLIGHT_CANCELLED':
        return '已结束预检，未创建订单';
      case 'MANUALLY_RESOLVED':
        return '已记录你在客户端的核对结果';
    }
  }

  /** 是否持有出码互斥（未结束的尝试）。 */
  busy(): boolean {
    return this.current != null && !this.current.finished;
  }

  /** 支付相关阶段暂停库存扫描。 */
  private blocksScan(): boolean {
    const r = this.current;
    return !!r && !r.finished && BUSY_STATES.includes(r.state) && r.state !== 'CHECKING';
  }

  private emit() {
    this.deps.onBusyChange(this.blocksScan());
    this.deps.onChange(this.view());
  }

  // ---------- 持久化 ----------

  private row(r: Runtime): AttemptRow {
    return {
      attempt_id: r.attemptId,
      profile_id: r.profileId,
      account_no: r.accountNo,
      params_json: JSON.stringify({ params: r.params, quote: r.quote }),
      state: r.state,
      payment_order_id: r.paymentOrderId,
      deadline_ms: r.deadlineMs,
      release_state: r.releaseState,
      lock_requested: r.lockRequested ? 1 : 0,
      create_sent: r.createSent ? 1 : 0,
      cleanup_done: r.cleanupDone ? 1 : 0,
      finished: r.finished ? 1 : 0,
      reason_json: r.reason ? JSON.stringify(r.reason) : null,
      resolution: null,
      trace_id: r.traceId,
      created_at: r.createdAt,
      updated_at: this.now(),
    };
  }

  private async persist(r: Runtime, extra: Partial<AttemptRow> = {}) {
    const row = this.row(r);
    const { attempt_id: _id, profile_id: _p, ...patch } = { ...row, ...extra };
    await this.deps.db.call('attempts.update', { attemptId: r.attemptId, patch });
  }

  private isCurrent(r: Runtime) {
    return this.current === r;
  }

  /** 迁移状态：PAID 为不可逆终态，迟到的响应不能降级。 */
  private async transition(r: Runtime, state: CheckoutState, patch: Partial<Runtime> = {}) {
    if (r.state === 'PAID' || r.state === 'MANUALLY_RESOLVED') return false;
    Object.assign(r, patch, { state });
    if (state === 'PAID') {
      r.finished = true;
      r.paymentImage = null;
      r.needsManualCheck = false;
      this.stopPolling(r);
    }
    if (state === 'PREFLIGHT_CANCELLED') r.finished = true;
    if ((state === 'EXPIRED' || state === 'REJECTED') && r.cleanupDone) r.finished = true;
    if (r.finished) r.paymentImage = null;
    await this.persist(r);
    this.deps.logger.info('checkout.state', { attempt: r.traceId, state });
    this.emit();
    return true;
  }

  // ---------- 入口 ----------

  async start(input: StartInput): Promise<CheckoutStartResult> {
    const profileId = this.deps.profile();
    if (!profileId) return { kind: 'BLOCKED', reason: '登录态不可用' };
    if (this.busy() && this.current) return { kind: 'EXISTING', attemptId: this.current.attemptId };
    const open = await this.deps.db.call('attempts.open', { profileId });
    if (open) {
      await this.adopt(open);
      return { kind: 'EXISTING', attemptId: open.attempt_id };
    }
    if ((await this.deps.agreementVersion()) !== AGREEMENT_VERSION) {
      return { kind: 'NEEDS_AGREEMENT', accountNo: input.accountNo };
    }
    let params = input.params;
    if (!params) {
      const preset = await this.deps.favorites.preset(input.accountNo);
      if (!preset || preset.quantity == null)
        return { kind: 'NEEDS_PRESET', accountNo: input.accountNo };
      params = { ...preset, quantity: preset.quantity };
    }
    // 从预检开始占用全局互斥（同步设置，防止双击/通知并发）
    if (this.busy() && this.current) return { kind: 'EXISTING', attemptId: this.current.attemptId };
    const r: Runtime = {
      attemptId: randomUUID(),
      profileId,
      accountNo: input.accountNo,
      state: 'CHECKING',
      params,
      quote: null,
      paymentOrderId: null,
      deadlineMs: null,
      monoDeadline: null,
      paymentImage: null,
      imageError: false,
      releaseState: 'NONE',
      reason: null,
      lockRequested: false,
      createSent: false,
      cleanupDone: false,
      finished: false,
      cancelRequested: false,
      needsManualCheck: false,
      checkingSince: null,
      statusNote: null,
      traceId: randomUUID().slice(0, 8),
      createdAt: this.now(),
      pollTimer: null,
      polling: false,
    };
    this.current = r;
    const created = await this.deps.db.call('attempts.create', { row: this.row(r) });
    if (!created.ok) {
      this.current = null;
      const existing = await this.deps.db.call('attempts.get', {
        attemptId: created.openAttemptId,
      });
      if (existing) await this.adopt(existing);
      return { kind: 'EXISTING', attemptId: created.openAttemptId };
    }
    this.deps.logger.info('checkout.start', {
      attempt: r.traceId,
      kind: params.rentKind,
      phase: input.source,
    });
    this.emit();
    void this.preflight(r, input).catch((error: unknown) => this.unexpected(r, error));
    return { kind: 'STARTED', attemptId: r.attemptId };
  }

  private async unexpected(r: Runtime, error: unknown) {
    this.deps.logger.error('checkout.unexpected', {
      attempt: r.traceId,
      reason: error instanceof Error ? error.name : 'ERROR',
    });
    if (!this.isCurrent(r) || r.finished) return;
    if (r.createSent && !r.paymentOrderId) {
      await this.transition(r, 'CREATE_UNKNOWN', { needsManualCheck: true });
    } else if (r.lockRequested || r.paymentOrderId) {
      await this.transition(r, 'RELEASE_UNKNOWN', { needsManualCheck: true });
    } else {
      await this.transition(r, 'REJECTED', {
        cleanupDone: true,
        reason: { code: 'INTERNAL', text: '出码流程异常，请重试', retryable: true },
      });
    }
  }

  private async reject(r: Runtime, code: string, text: string, retryable: boolean) {
    r.reason = { code, text, retryable };
    if (!r.lockRequested) {
      r.cleanupDone = true;
      await this.transition(r, 'REJECTED');
      return;
    }
    await this.transition(r, 'REJECTED');
    await this.release(r, 'REJECTED');
  }

  // ---------- 预检与创建 ----------

  private async preflight(r: Runtime, input: StartInput) {
    const params = r.params as OrderParams;
    const stop = async () => {
      if (!r.cancelRequested) return false;
      if (!r.lockRequested) {
        r.cleanupDone = true;
        await this.transition(r, 'PREFLIGHT_CANCELLED');
      } else {
        await this.release(r, 'PREFLIGHT_CANCELLED');
      }
      return true;
    };
    let record: Awaited<ReturnType<AccountService['detail']>>['record'];
    let quote: ReturnType<typeof computeQuote>;
    let channelId: string;
    try {
      const restrictions = await this.deps.auth.refreshRestrictions();
      if (await stop()) return;
      if (restrictions.banned) return this.reject(r, 'BANNED', REASON_TEXT.BANNED, false);
      if (restrictions.maintenance)
        return this.reject(r, 'MAINTENANCE', '平台维护中，暂时无法下单', false);
      if (!restrictions.certified)
        return this.reject(r, 'NOT_CERTIFIED', '账号尚未完成实名认证，请先在 5E 客户端完成', false);
      if (!restrictions.agreementDone)
        return this.reject(
          r,
          'PLATFORM_AGREEMENT',
          '请先在 5E 客户端阅读并同意租赁协议，助手不代签',
          false,
        );
      const detail = await this.deps.accounts.detail(r.accountNo, {
        priority: Priority.CHECKOUT,
        refresh: true,
      });
      record = detail.record;
      if (await stop()) return;
      if (record.status === 'RENTED') return this.reject(r, 'TAKEN', REASON_TEXT.TAKEN, false);
      if (record.status === 'OFF_SHELF')
        return this.reject(r, 'OFF_SHELF', REASON_TEXT.OFF_SHELF, false);
      if (record.status !== 'AVAILABLE')
        return this.reject(r, 'STATUS_UNKNOWN', '无法确认账号可租状态，请稍后重试', true);
      const durations = RENT_META[params.rentKind].slot
        ? null
        : await this.deps.api.durations(r.accountNo, { priority: Priority.CHECKOUT });
      if (await stop()) return;
      const channels = await this.deps.api.payChannels({ priority: Priority.CHECKOUT });
      const channel = channels.find((c) => c.payChannel === params.payChannel);
      if (!channel) {
        return this.reject(
          r,
          'CHANNEL_UNAVAILABLE',
          '所选支付方式当前不可用，请重新选择支付方式',
          true,
        );
      }
      channelId = channel.payChannelId;
      const coupons =
        params.autoCoupon && record.couponAllowed
          ? await this.deps.api.coupons({ priority: Priority.CHECKOUT })
          : null;
      if (await stop()) return;
      const serverNow = detail.serverTimeMs ?? coupons?.serverTimeMs ?? this.now();
      if (
        RENT_META[params.rentKind].slot &&
        !slotOrderable(params.rentKind, serverNow, record.pricing.weekRange)
      ) {
        return this.reject(r, 'SLOT_CLOSED', REASON_TEXT.SLOT_CLOSED, false);
      }
      quote = computeQuote({
        record,
        durations,
        rentKind: params.rentKind,
        quantity: params.quantity,
        autoCoupon: params.autoCoupon,
        coupons,
        nowMs: serverNow,
      });
    } catch (error) {
      if (isCancelled(error)) return;
      if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') {
        return this.reject(r, 'AUTH_EXPIRED', '登录态已失效，请在客户端重新登录后重新读取', true);
      }
      return this.reject(r, 'READ_FAILED', `读取失败，请重试（${userMessage(error)}）`, true);
    }
    if (!quote.ok) {
      return this.reject(
        r,
        quote.code,
        QUOTE_ERROR_TEXT[quote.code],
        quote.code !== 'RENT_UNSUPPORTED',
      );
    }
    r.quote = {
      amountFen: quote.choice.amountFen,
      originalFen: quote.choice.originalFen,
      discountFen: quote.choice.discountFen,
      couponApplied: quote.choice.couponId != null,
    };
    // 报价变化：更新界面并停止本次触发，要求用户按新报价再次手动发起
    const expectedUnit = input.expectedUnitYuan ?? null;
    const expectedAmount = input.expectedAmountYuan ?? null;
    const changedUnit = expectedUnit != null && Number(expectedUnit) !== Number(quote.unitYuan);
    const changedAmount =
      expectedAmount != null &&
      fenToDisplayYuan(quote.choice.amountFen) !== Number(expectedAmount).toFixed(2);
    if (changedUnit || changedAmount) {
      return this.reject(
        r,
        'PRICE_CHANGED',
        `报价已变化：本次金额 ¥${fenToDisplayYuan(quote.choice.amountFen)}，请确认后重新点击一键出码`,
        true,
      );
    }
    if (await stop()) return;
    // 平台锁校验：此后保守视为可能持有锁
    r.lockRequested = true;
    await this.persist(r);
    try {
      await this.deps.api.checkLock(r.accountNo);
    } catch (error) {
      if (!this.isCurrent(r)) return;
      if (error instanceof PlatformError && error.code === 'BUSINESS') {
        return this.reject(
          r,
          'LOCK_REJECTED',
          error.details.platformMessage || '账号当前无法锁定下单',
          false,
        );
      }
      return this.reject(r, 'LOCK_FAILED', `锁号预检失败：${userMessage(error)}`, true);
    }
    if (await stop()) return;
    // 持久化尝试并创建一次
    r.createSent = true;
    await this.transition(r, 'CREATING');
    const body = {
      accountNo: r.accountNo,
      buyCount: params.quantity,
      buyTimeType: RENT_META[params.rentKind].code,
      payChannel: params.payChannel,
      realAmount: quote.choice.amountFen,
      propId: quote.choice.propId === '0' ? 0 : quote.choice.propId,
      payChannelId: /^\d+$/.test(channelId) ? Number(channelId) : channelId,
    };
    let created: Awaited<ReturnType<PlatformApi['createOrder']>>;
    try {
      created = await this.deps.api.createOrder(body);
    } catch (error) {
      if (!this.isCurrent(r)) return;
      if (error instanceof PlatformError && error.code === 'BUSINESS') {
        const code = error.details.businessCode;
        const text =
          code === 533
            ? error.details.platformMessage || '平台拒绝创建订单'
            : error.details.platformMessage || '平台拒绝创建订单，请检查参数后重试';
        return this.reject(r, code === 533 ? 'CREATE_533' : 'CREATE_REJECTED', text, code !== 533);
      }
      if (error instanceof PlatformError && error.code === 'AUTH_EXPIRED') {
        await this.transition(r, 'RELEASE_UNKNOWN', {
          needsManualCheck: true,
          reason: {
            code: 'AUTH_EXPIRED',
            text: '登录态失效，无法确认创建结果，请到 5E 客户端核对订单',
            retryable: false,
          },
        });
        return;
      }
      // 网络结果不明：不重发创建；执行受控释放并引导客户端核对
      await this.transition(r, 'CREATE_UNKNOWN', { needsManualCheck: true });
      await this.releaseOnce(r);
      return;
    }
    // 先保存支付订单 ID 与服务器截止时间，再展示付款码
    const remainMs = Number.isFinite(created.orderRemainSeconds)
      ? created.orderRemainSeconds * 1000
      : 0;
    const dateline = Number(created.orderDateline);
    r.paymentOrderId = created.orderId;
    r.deadlineMs =
      Number.isFinite(dateline) && dateline > 0
        ? dateline > 1e12
          ? dateline
          : dateline * 1000
        : this.now() + remainMs;
    r.monoDeadline = this.mono() + remainMs;
    await this.persist(r);
    if (!this.isCurrent(r)) return;
    r.paymentImage = await this.deps.loadPaymentImage(created.codeUrl).catch(() => null);
    r.imageError = r.paymentImage == null;
    await this.transition(r, 'PENDING');
    this.schedulePoll(r, 0);
  }

  // ---------- 轮询 ----------

  private pollInterval() {
    return Math.max(3000, Math.ceil(90_000 / Math.max(1, this.deps.rateLimit())));
  }

  private stopPolling(r: Runtime) {
    if (r.pollTimer) clearTimeout(r.pollTimer);
    r.pollTimer = null;
  }

  private schedulePoll(r: Runtime, delay: number) {
    this.stopPolling(r);
    if (r.finished || !r.paymentOrderId) return;
    r.pollTimer = setTimeout(() => {
      r.pollTimer = null;
      void this.poll(r);
    }, delay);
  }

  /** 休眠恢复：立即排入状态核对。 */
  resumeFromSleep() {
    const r = this.current;
    if (r && !r.finished && r.paymentOrderId && !r.polling) this.schedulePoll(r, 0);
  }

  private async poll(r: Runtime) {
    if (!this.isCurrent(r) || r.finished || !r.paymentOrderId || r.polling) return;
    r.polling = true;
    try {
      const pastDeadline = r.monoDeadline != null ? this.mono() >= r.monoDeadline : true;
      if (pastDeadline && r.state === 'PENDING') {
        r.paymentImage = null;
        r.checkingSince ??= this.now();
      }
      let status: { payStatus: number; abnormalReason: number };
      try {
        status = await this.deps.api.payStatus(r.paymentOrderId);
      } catch (error) {
        if (!this.isCurrent(r)) return;
        if (r.checkingSince != null && this.now() - r.checkingSince > RECOVERY_LIMIT_MS) {
          r.needsManualCheck = true;
          r.statusNote = '暂时无法确认订单状态，请到 5E 客户端核对';
          this.emit();
          return;
        }
        this.deps.logger.warn('checkout.poll', {
          attempt: r.traceId,
          reason: error instanceof PlatformError ? error.code : 'ERROR',
        });
        this.emit();
        this.schedulePoll(r, this.pollInterval());
        return;
      }
      if (!this.isCurrent(r)) return;
      await this.applyStatus(r, status.payStatus, status.abnormalReason);
    } finally {
      r.polling = false;
    }
  }

  private async applyStatus(r: Runtime, payStatus: number, abnormal: number) {
    const verdict = payVerdict(payStatus, abnormal);
    r.statusNote = null;
    switch (verdict.kind) {
      case 'PAID':
        await this.transition(r, 'PAID');
        return;
      case 'EXPIRED':
        r.paymentImage = null;
        if (r.releaseState === 'ACCEPTED') {
          r.cleanupDone = true;
          await this.transition(r, 'EXPIRED');
          return;
        }
        await this.transition(r, 'EXPIRED');
        await this.release(r, 'EXPIRED');
        return;
      case 'REJECTED':
        r.paymentImage = null;
        r.reason = { code: verdict.code, text: verdict.text, retryable: verdict.retryable };
        if (r.releaseState === 'ACCEPTED') {
          r.cleanupDone = true;
          await this.transition(r, 'REJECTED');
          return;
        }
        await this.transition(r, 'REJECTED');
        await this.release(r, 'REJECTED');
        return;
      case 'PAYMENT_ABNORMAL':
      case 'UNKNOWN':
        r.paymentImage = null;
        await this.transition(r, 'STATUS_UNKNOWN', {
          needsManualCheck: true,
          reason: { code: verdict.kind, text: verdict.text, retryable: false },
        });
        return;
      case 'PENDING': {
        const pastDeadline = r.monoDeadline == null || this.mono() >= r.monoDeadline;
        const inRelease =
          r.state === 'RELEASE_ACCEPTED' || r.state === 'RELEASE_PENDING' || r.cancelRequested;
        if (pastDeadline || inRelease) {
          r.checkingSince ??= this.now();
          if (this.now() - r.checkingSince > RECOVERY_LIMIT_MS) {
            r.needsManualCheck = true;
            r.statusNote = '平台尚未给出终态，请到 5E 客户端核对订单';
            await this.persist(r);
            this.emit();
            return;
          }
        }
        this.emit();
        this.schedulePoll(r, this.pollInterval());
      }
    }
  }

  // ---------- 取消与释放 ----------

  /** 用户确认取消（界面已二次确认）。 */
  async cancel(): Promise<void> {
    const r = this.current;
    if (!r || r.finished) return;
    if (r.state === 'CHECKING') {
      r.cancelRequested = true;
      if (!r.lockRequested) {
        r.cleanupDone = true;
        await this.transition(r, 'PREFLIGHT_CANCELLED');
      } else {
        this.emit();
      }
      return;
    }
    if (r.state !== 'PENDING' || r.cancelRequested) return;
    r.cancelRequested = true;
    r.paymentImage = null;
    this.stopPolling(r);
    await this.transition(r, 'RELEASE_PENDING');
    // 先核对一次支付状态；已支付则展示成功，不解锁
    if (r.paymentOrderId) {
      try {
        const status = await this.deps.api.payStatus(r.paymentOrderId);
        const verdict = payVerdict(status.payStatus, status.abnormalReason);
        if (verdict.kind === 'PAID') {
          await this.transition(r, 'PAID');
          return;
        }
        if (verdict.kind !== 'PENDING') {
          await this.applyStatus(r, status.payStatus, status.abnormalReason);
          return;
        }
      } catch {
        // 无法核对时仍申请释放，结果继续以平台为准
      }
    }
    await this.release(r, null);
  }

  /** 申请释放（只发送一次）：成功仅记为“释放请求已受理”，继续核对已知支付 ID。 */
  private async release(
    r: Runtime,
    terminal: 'EXPIRED' | 'REJECTED' | 'PREFLIGHT_CANCELLED' | null,
  ) {
    if (!this.isCurrent(r) || r.state === 'PAID') return;
    if (r.releaseState !== 'NONE') return;
    const ok = await this.releaseOnce(r);
    if (!this.isCurrent(r) || (r.state as CheckoutState) === 'PAID') return;
    if (!ok) {
      await this.transition(r, 'RELEASE_UNKNOWN', { needsManualCheck: true });
      return;
    }
    if (terminal === 'PREFLIGHT_CANCELLED') {
      r.cleanupDone = true;
      await this.transition(r, 'PREFLIGHT_CANCELLED');
      return;
    }
    if (terminal === 'EXPIRED' || terminal === 'REJECTED') {
      r.cleanupDone = true;
      await this.transition(r, terminal);
      return;
    }
    await this.transition(r, 'RELEASE_ACCEPTED');
    if (r.paymentOrderId) {
      r.checkingSince = this.now();
      this.schedulePoll(r, this.pollInterval());
    } else {
      r.needsManualCheck = true;
      this.emit();
    }
  }

  private async releaseOnce(r: Runtime): Promise<boolean> {
    if (r.releaseState !== 'NONE') return r.releaseState === 'ACCEPTED';
    r.releaseState = 'REQUESTED';
    await this.persist(r);
    try {
      await this.deps.api.unlock(r.accountNo);
      r.releaseState = 'ACCEPTED';
      await this.persist(r);
      this.deps.logger.info('checkout.release', { attempt: r.traceId, state: 'ACCEPTED' });
      this.emit();
      return true;
    } catch (error) {
      r.releaseState = 'FAILED';
      await this.persist(r);
      this.deps.logger.warn('checkout.release', {
        attempt: r.traceId,
        state: 'FAILED',
        reason: error instanceof PlatformError ? error.code : 'ERROR',
      });
      this.emit();
      return false;
    }
  }

  /** 用户在客户端核对后人工处理；没有用户确认不得自动清除。 */
  async manualResolve(result: 'PAID' | 'NO_PENDING'): Promise<void> {
    const r = this.current;
    if (!r || r.finished) return;
    if (
      ![
        'CREATE_UNKNOWN',
        'STATUS_UNKNOWN',
        'RELEASE_UNKNOWN',
        'RELEASE_ACCEPTED',
        'PENDING',
      ].includes(r.state)
    )
      return;
    if ((r.state === 'PENDING' || r.state === 'RELEASE_ACCEPTED') && !r.needsManualCheck) return;
    this.stopPolling(r);
    r.finished = true;
    r.paymentImage = null;
    r.state = 'MANUALLY_RESOLVED';
    r.reason = {
      code: result,
      text:
        result === 'PAID'
          ? '你已确认在客户端完成支付，请回到 5E 客户端上号'
          : '你已确认客户端中没有待支付订单',
      retryable: false,
    };
    await this.persist(r, { resolution: `${result}@${this.now()}` });
    this.deps.logger.info('checkout.manual', { attempt: r.traceId, state: result });
    this.emit();
  }

  /** 关闭已结束尝试的弹窗；未结束的尝试只能隐藏，不会被清除。 */
  dismiss() {
    if (this.current?.finished) {
      this.current = null;
      this.emit();
    }
  }

  // ---------- 恢复 ----------

  /** 同一身份启动或重新读取后，先处理未结束的订单记录。 */
  async recover(profileId: string): Promise<void> {
    const open = await this.deps.db.call('attempts.open', { profileId });
    if (!open) return;
    await this.adopt(open);
  }

  private async adopt(row: AttemptRow) {
    if (this.current && this.current.attemptId === row.attempt_id) return;
    let stored: { params: OrderParams | null; quote: Runtime['quote'] } = {
      params: null,
      quote: null,
    };
    try {
      stored = JSON.parse(row.params_json);
    } catch {
      // 保留空参数
    }
    let reason: Runtime['reason'] = null;
    try {
      reason = row.reason_json ? JSON.parse(row.reason_json) : null;
    } catch {
      reason = null;
    }
    const r: Runtime = {
      attemptId: row.attempt_id,
      profileId: row.profile_id,
      accountNo: row.account_no,
      state: row.state as CheckoutState,
      params: stored.params,
      quote: stored.quote,
      paymentOrderId: row.payment_order_id,
      deadlineMs: row.deadline_ms,
      monoDeadline:
        row.deadline_ms != null ? this.mono() + Math.max(0, row.deadline_ms - this.now()) : null,
      paymentImage: null,
      imageError: false,
      releaseState: (row.release_state as Runtime['releaseState']) ?? 'NONE',
      reason,
      lockRequested: row.lock_requested === 1,
      createSent: row.create_sent === 1,
      cleanupDone: row.cleanup_done === 1,
      finished: false,
      cancelRequested: false,
      needsManualCheck: false,
      checkingSince: null,
      statusNote: null,
      traceId: row.trace_id,
      createdAt: row.created_at,
      pollTimer: null,
      polling: false,
    };
    this.current = r;
    this.deps.logger.info('checkout.recover', { attempt: r.traceId, state: r.state });
    // 付款码不落盘：恢复时不重新展示，也绝不重建订单
    if (r.releaseState === 'REQUESTED') {
      await this.transition(r, 'RELEASE_UNKNOWN', { needsManualCheck: true });
      return;
    }
    switch (r.state) {
      case 'CHECKING':
        if (!r.lockRequested) {
          r.cleanupDone = true;
          await this.transition(r, 'PREFLIGHT_CANCELLED');
        } else {
          this.emit();
          await this.release(r, 'PREFLIGHT_CANCELLED');
        }
        return;
      case 'CREATING':
        await this.transition(r, 'CREATE_UNKNOWN', { needsManualCheck: true });
        await this.releaseOnce(r);
        this.emit();
        return;
      case 'CREATE_UNKNOWN':
      case 'STATUS_UNKNOWN':
      case 'RELEASE_UNKNOWN':
        r.needsManualCheck = true;
        this.emit();
        return;
      case 'PENDING':
      case 'RELEASE_PENDING':
      case 'RELEASE_ACCEPTED':
        if (r.state === 'RELEASE_PENDING' && r.releaseState === 'NONE') {
          r.cancelRequested = true;
        }
        if (r.state === 'PENDING') r.statusNote = '付款码不会在重启后重新展示；正在核对订单状态';
        r.checkingSince = this.now();
        this.emit();
        if (r.paymentOrderId) this.schedulePoll(r, 0);
        else {
          r.needsManualCheck = true;
          this.emit();
        }
        if (r.state === 'RELEASE_PENDING' && r.releaseState === 'NONE') await this.release(r, null);
        return;
      case 'EXPIRED':
      case 'REJECTED':
        if (r.cleanupDone) {
          r.finished = true;
          await this.persist(r);
          this.emit();
        } else if (r.lockRequested || r.paymentOrderId) {
          this.emit();
          await this.release(r, r.state);
        } else {
          r.cleanupDone = true;
          r.finished = true;
          await this.persist(r);
          this.emit();
        }
        return;
      default:
        this.emit();
    }
  }

  // ---------- 退出 ----------

  /** 显式退出：对待支付尝试执行一次清理，最多等待 15 秒；未确认结果下次启动恢复。 */
  async prepareQuit(): Promise<void> {
    const r = this.current;
    if (!r || r.finished) return;
    const work = (async () => {
      if (r.state === 'PENDING' && !r.cancelRequested) await this.cancel();
      else if (r.state === 'CHECKING') await this.cancel();
    })();
    await Promise.race([work, new Promise((resolve) => setTimeout(resolve, QUIT_WAIT_MS))]);
    this.stopPolling(r);
    await this.persist(r);
  }

  /** 身份切换：停止旧身份的轮询，保留其记录供切回处理。 */
  detach() {
    const r = this.current;
    if (r) this.stopPolling(r);
    this.current = null;
    this.emit();
  }
}
