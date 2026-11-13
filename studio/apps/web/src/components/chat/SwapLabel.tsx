/**
 * 一句状态的**换词**:旧词向上淡出、新词从下方淡入,中间不出现一帧「两个词都没有」或
 * 「宽度突然跳一下」(Fantay 2026-11-08 交互打磨,owner:「动画…非常的垃圾和不协调」)。
 *
 * 用在执行记录的壳头:「进行中」→「已完成 · 已思考 2s · 3 个操作」/「运行失败 · 原因」/
 * 「已取消」。原来这一下是**原地换字**:扫光的词瞬间变成静态词,后面的耗时和箭头跟着
 * 宽度差横跳一截。
 *
 * 一套语法(见 chat 打磨简报 §1 / §2,数值是约定,不在这里调):
 *  · 出:opacity → 0、translateY(-4px)、blur(2px),`--chat-dur-exit`,走得比进快;
 *  · 进:从 translateY(4px) + blur(2px) 到静止,`--chat-dur-swap`(300ms),`--chat-ease-out`;
 *  · 宽度:在新旧两个宽度之间滑过去(同一条时钟),所以右边的秒数与箭头不会瞬移。
 *
 * 判据只有一个:**`swapKey` 变了才算换词**。同一个 key 下内容变了(比如失败原因晚一帧
 * 才到、摘要里的操作数又多了一个)是原地更新,不演换词 —— 不然每一帧都在「换」。
 *
 * 三条边界:
 *  1. **挂载不演。** 历史会话一打开就是落定的词,不许每个壳头都淡入一遍。
 *  2. **出去的那个词不进读屏、不进文本。** 它是 `aria-hidden` 的残影,只活一个换词周期
 *     (`SWAP_SETTLE_MS`)就卸掉;读屏和 `textContent` 永远只读到新词。
 *  3. **减少动态效果时直接换字**,不留残影、不滑宽度(CSS 与 JS 两侧都关)。
 *     问不到偏好的环境(没有 `matchMedia`)按「不动」处理 —— 动效只在能确认允许时才上。
 */
import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import styles from './SwapLabel.module.css';

/** 一次换词从开始到落定的时长,和 CSS 里 `--chat-dur-swap` 的 300ms 是同一个数 */
export const SWAP_SETTLE_MS = 300;

export interface SwapLabelProps {
  /** 这句话**说的是哪一档**。变了 = 换词;不变 = 原地更新 */
  swapKey: string;
  children: ReactNode;
  /** 外层盒子(参与父级 flex 收缩的那一个) */
  className?: string;
  /** 新旧两层共用的排版 —— 残影必须和它被换下之前长得一模一样 */
  layerClassName?: string;
}

function motionAllowed(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface SwapState {
  /** 第几次换词 —— 新词那一层按它重挂,连着换两次也会重新入场 */
  gen: number;
  /** 正在退场的旧内容;`null` = 已落定 */
  outgoing: ReactNode | null;
}

export function SwapLabel({ swapKey, children, className, layerClassName }: SwapLabelProps): ReactElement {
  const boxRef = useRef<HTMLSpanElement>(null);
  const outRef = useRef<HTMLSpanElement>(null);
  /** 上一次**提交到屏幕上**的 key 与内容 —— 换词时它就是那个要退场的旧词 */
  const shownRef = useRef<{ key: string; node: ReactNode }>({ key: swapKey, node: children });
  const [swap, setSwap] = useState<SwapState>({ gen: 0, outgoing: null });

  /*
   * 每次提交之后记下屏幕上是什么;key 变了就把**上一份**交给退场层。
   * 没有依赖数组是故意的:同 key 下的原地更新也要记,下次换词时退场的才是最后那一版。
   * 这里不读布局,所以每帧跑一次没有成本。
   */
  useLayoutEffect(() => {
    const shown = shownRef.current;
    shownRef.current = { key: swapKey, node: children };
    if (shown.key === swapKey || !motionAllowed()) return;
    setSwap((current) => ({ gen: current.gen + 1, outgoing: shown.node }));
  });

  /*
   * 宽度滑过去:先钉在旧宽度(残影层量得出来 —— 它绝对定位,画的正是旧内容),
   * 强制一次布局,再放到新宽度,过渡挂在 `data-gliding` 上。落定后把宽度还给内容。
   * 直接写 DOM 而不是走 state:这两样 React 都不管(没有 `style` / `data-gliding` 属性),
   * 走 state 只会多两次渲染。
   */
  useLayoutEffect(() => {
    const box = boxRef.current;
    const out = outRef.current;
    if (swap.outgoing == null || !box) return;
    const from = out?.getBoundingClientRect().width ?? 0;
    const to = box.getBoundingClientRect().width;
    if (from > 0 && to > 0 && Math.abs(to - from) > 0.5) {
      box.style.width = `${from}px`;
      void box.offsetWidth;
      box.setAttribute('data-gliding', '');
      box.style.width = `${to}px`;
    }
    const timer = window.setTimeout(() => {
      box.style.width = '';
      box.removeAttribute('data-gliding');
      setSwap((current) => (current.outgoing == null ? current : { ...current, outgoing: null }));
    }, SWAP_SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      box.style.width = '';
      box.removeAttribute('data-gliding');
    };
  }, [swap]);

  /*
   * 退场那一份是旧内容的**副本**,只活 SWAP_SETTLE_MS。它身上的测试钩子 / id / title 会和新内容
   * 撞名(两个 `chat-shell-status`,严格定位器当场报错),所以挂上来就把它们摘掉;
   * 容器自己的 `chat-swap-outgoing` 留着,读屏由 `aria-hidden` 挡掉。
   */
  useLayoutEffect(() => {
    const out = outRef.current;
    if (!out) return;
    for (const node of out.querySelectorAll('[data-testid],[id],[title]')) {
      node.removeAttribute('data-testid');
      node.removeAttribute('id');
      node.removeAttribute('title');
    }
  }, [swap.outgoing]);

  const layer = layerClassName ? ` ${layerClassName}` : '';
  return (
    <span ref={boxRef} className={className ? `${styles.swap} ${className}` : styles.swap}>
      <span
        key={swap.gen}
        className={`${styles.current}${layer}`}
        data-entering={swap.outgoing != null ? '' : undefined}
      >
        {children}
      </span>
      {swap.outgoing != null ? (
        <span
          ref={outRef}
          className={`${styles.outgoing}${layer}`}
          aria-hidden="true"
          data-testid="chat-swap-outgoing"
        >
          {swap.outgoing}
        </span>
      ) : null}
    </span>
  );
}
