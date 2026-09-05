import { config } from './config'

export function claudeModelKey(model: string): string {
  return model.startsWith('claude:') ? model : `claude:${model}`
}

/** 解析旧 claude:<profile> 选择；Token Source 传入的真实模型名直接保留。 */
export function resolveClaudeSdkModel(model: string | null | undefined): string {
  if (!model || model === 'default' || model === 'claude:default') return 'opus'
  if (!model.startsWith('claude:')) return model
  const name = model.slice('claude:'.length)
  if (name === 'glm' || Object.hasOwn(config.claude.models, name)) {
    return config.claude.models[name]?.model?.trim() || 'opus'
  }
  return name
}
