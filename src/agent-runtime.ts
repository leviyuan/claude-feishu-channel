export function agentApiUrl(bind: string, port: number): string {
  const host = bind === '0.0.0.0'
    ? '127.0.0.1'
    : bind === '::' || bind === '::1'
      ? '[::1]'
      : bind
  return `http://${host}:${port}`
}
