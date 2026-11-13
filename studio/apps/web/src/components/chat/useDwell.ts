/**
 * 「刚结束的东西再留一会儿」—— 一个只管**相位**的小钩子。
 *
 * 返回值:`flag` 为真时为真;`flag` 由真翻假之后**再保持 `ms` 毫秒**为真,然后才落成假。
 *
 * 为什么需要它(Fantay 2026-11-08,owner 原话「思考过程经常没有」):
 * 快的推理模型(DeepSeek Flash 量级 ≈1s)在一次重渲染里就完成了「开始想 → 想完 → 收起」,
 * 思考那一格和执行记录的壳在屏幕上根本没被看见就折回去了。收起本身没错,错的是**它和
 * 结束发生在同一帧**。这个钩子把「该收了」往后推一小段,让人先看清它想了什么、做了什么。
 *
 * 三条约束,都是给调用方的承诺:
 *  1. **挂载那一帧不驻留。** 初值就是 `flag` 本身 —— 打开一段历史会话时,早就结束的那几格
 *     必须直接是收起的,而不是每一格都先摊开再收一遍。
 *  2. **下降沿当帧就成立。** 下降沿在渲染期间就被认出来(派生状态),所以 `flag` 翻假的
 *     那一次提交里返回值仍然是真 —— 不会先提交一个「假」再被 effect 拨回「真」,
 *     消费方(`Foldable` 的 `lifecycleOpen`)也就不会看到一次收起 → 展开的闪动。
 *  3. **上升沿立刻取消驻留。** 驻留期间 `flag` 又变真(下一段推理接着来了),直接跟随 `flag`。
 *
 * 不碰 `prefers-reduced-motion`:驻留不是动画,是「这个状态还在屏幕上多久」——
 * 减少动态效果的读者同样需要看见刚才那段思考。
 */
import { useEffect, useState } from 'react';

interface DwellEdge {
  /** 上一次看到的 `flag` —— 只用来在渲染期间认出边沿 */
  flag: boolean;
  /** 正在驻留的那一段;每个下降沿一枚新对象,好让计时器只认它自己那一段 */
  hold: { ms: number } | null;
}

export function useDwell(flag: boolean, ms: number): boolean {
  const [edge, setEdge] = useState<DwellEdge>(() => ({ flag, hold: null }));
  if (edge.flag !== flag) {
    // 渲染期间的派生状态:React 会带着新状态立刻重跑这一次渲染,不提交中间值。
    setEdge({ flag, hold: !flag && ms > 0 ? { ms } : null });
  }
  const hold = edge.hold;
  useEffect(() => {
    if (!hold) return;
    const timer = setTimeout(() => {
      setEdge((current) => (current.hold === hold ? { ...current, hold: null } : current));
    }, hold.ms);
    return () => clearTimeout(timer);
  }, [hold]);
  return flag || hold != null;
}
