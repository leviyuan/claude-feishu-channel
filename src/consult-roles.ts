export const CONSULT_ROLES = [
  'general',
  'correctness',
  'architecture',
  'security',
  'testing',
  'maintainability',
] as const

export type ConsultRole = (typeof CONSULT_ROLES)[number]

export function roleLabel(role: ConsultRole): string {
  switch (role) {
    case 'correctness': return '正确性审查'
    case 'architecture': return '架构审查'
    case 'security': return '安全审查'
    case 'testing': return '测试与回归'
    case 'maintainability': return '简化与可维护性'
    default: return '通用顾问'
  }
}

export function roleInstructions(role: ConsultRole): string {
  switch (role) {
    case 'correctness': return '优先检查逻辑错误、边界条件、竞态和错误处理，每个结论给出可验证证据。'
    case 'architecture': return '优先检查模块边界、状态所有权、协议契约和长期演进风险。'
    case 'security': return '优先检查权限、凭据泄露、命令注入、路径越界、不可逆副作用和供应链风险。'
    case 'testing': return '优先检查验收标准、回归面、失败路径、并发时序和测试可观测性。'
    case 'maintainability': return '优先检查不必要的抽象、重复真相源、过度复杂度和可删减代码。'
    default: return '独立评估问题，明确区分已验证事实、推断、风险和待确认项。'
  }
}
