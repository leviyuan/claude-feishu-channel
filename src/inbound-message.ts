/** Message freshness is measured when the daemon accepts the WS event, not
 * when a per-chat FIFO eventually gets around to processing it. */
export function isStaleAtReceipt(
  createTime: number,
  receivedAt: number,
  thresholdMs: number,
): boolean {
  return createTime > 0 && receivedAt - createTime > thresholdMs
}
