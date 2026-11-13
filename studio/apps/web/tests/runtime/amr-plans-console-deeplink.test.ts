/**
 * T54(产品口述 2026-09-06)把升级按钮从写死的生产 Pricing 挪回了「console 的
 * 套餐页」。品牌更名之后 console 就是 TokenToSea 的计费页
 * (`https://tokentosea.com/#/billing`),并且**所有 profile 共用这一页**:不再有
 * test / local / feature-test 各自的 console,也不再接受 daemon 报上来的
 * runtime console origin。
 *
 * 这里仍然钉住 T54 那条事故线 —— 升级不许落到 Pricing —— 同时钉住更名后的
 * 新口径:任何 profile、任何 runtime origin 都改不动这个落点。工作区版仍然带上
 * workspaceId 和同一个套餐意图(`billing=plan`)。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AMR_RECHARGE_URL,
  amrPlansUrlForProfile,
  amrPlansUrlForWorkspace,
  setRuntimeAmrConsoleOrigin,
} from '../../src/runtime/amr-guidance';

const TOKENTOSEA_BILLING_URL = 'https://tokentosea.com/#/billing';

// 站位用的内部环境 console origin。更名之后它不再影响任何落点。
const RUNTIME_CONSOLE_ORIGIN = 'https://vela.example.invalid';

afterEach(() => {
  setRuntimeAmrConsoleOrigin(null);
});

describe('升级按钮的落点:TokenToSea 计费页', () => {
  it('prod 落在 TokenToSea 计费页,而不是 Pricing', () => {
    expect(DEFAULT_AMR_RECHARGE_URL).toBe(TOKENTOSEA_BILLING_URL);
    expect(amrPlansUrlForProfile('prod')).toBe(TOKENTOSEA_BILLING_URL);
    expect(amrPlansUrlForProfile('prod')).not.toContain('/pricing');
  });

  it.each(['test', 'local', 'feature-test'])(
    '%s profile 落在同一个 TokenToSea 计费页,不落在 Pricing',
    (profile) => {
      expect(amrPlansUrlForProfile(profile)).toBe(TOKENTOSEA_BILLING_URL);
      expect(amrPlansUrlForProfile(profile)).not.toContain('/pricing');
    },
  );

  it('daemon 报的 runtime console origin 改不动任何 profile 的落点', () => {
    setRuntimeAmrConsoleOrigin(RUNTIME_CONSOLE_ORIGIN);
    for (const profile of ['prod', 'test', 'local', 'feature-test', null, ' unknown ']) {
      expect(amrPlansUrlForProfile(profile)).toBe(TOKENTOSEA_BILLING_URL);
    }
  });

  it('工作区版带上 workspaceId,并且用同一个意图', () => {
    setRuntimeAmrConsoleOrigin(RUNTIME_CONSOLE_ORIGIN);
    const url = amrPlansUrlForWorkspace('feature-test', ' workspace-a ');
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe('https://tokentosea.com');
    expect(parsed.hash).toBe('#/billing');
    expect(parsed.searchParams.get('workspaceId')).toBe('workspace-a');
    expect(parsed.searchParams.get('billing')).toBe('plan');
  });

  it('没有工作区身份时仍然失败关闭', () => {
    expect(amrPlansUrlForWorkspace('feature-test', null)).toBeNull();
    expect(amrPlansUrlForWorkspace('feature-test', '   ')).toBeNull();
  });
});
