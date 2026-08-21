/**
 * Dead-man's switch(回滚看门狗)。
 *
 * 背景:没 SSH 兜底时,restart daemon 有「新代码让会话起不来 → 飞书通道断 → 救不回」
 * 的风险(我就跑在 daemon 的会话里,起不来用户就失联)。
 *
 * 解法:restart 前用 systemd-run 起一个**独立**看门狗 unit(30min 倒计时,到点执行
 * `git reset --hard <token source 改动前> + systemctl restart feishu-daemon`)。
 * 会话 init 成功时调 clearRollbackWatchdog() 停掉它(证明我真起来了,不需要自救)。
 * 若 30min 内会话没 init(会话起不来),看门狗自动回滚到旧代码,daemon 自救。
 *
 * 关键:看门狗是 daemon 外的 systemd unit,daemon restart 杀不到它;清看门狗绑在
 * 「会话 init」而非「daemon 启动」—— daemon 进程起 ≠ 会话起得来(spawn bug 正好让
 * daemon 在跑但会话起不来)。只有会话真 init 才算「我起来了」。
 */
import { exec } from 'node:child_process'

const WATCHDOG_UNIT = 'cc-feishu-rollback-watchdog'

/**
 * 会话 init 成功时调:停掉回滚看门狗。异步、fire-and-forget,不阻塞 init。
 * 多次调用无害(看门狗已停 / 不存在时 systemctl 返回非零,被吞)。
 */
export function clearRollbackWatchdog(): void {
  if (process.env.NODE_ENV === 'test') return
  exec(
    `systemctl --user stop ${WATCHDOG_UNIT}.timer ${WATCHDOG_UNIT}.service 2>/dev/null`,
    () => { /* no-op:看门狗不存在/已停都正常 */ },
  )
}
