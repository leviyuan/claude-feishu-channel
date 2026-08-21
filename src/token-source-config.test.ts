import { describe, expect, test } from 'bun:test'
import { removeTokenSourceSectionText } from './token-source-config'

describe('token source config section editing', () => {
  test('removes a whole section even when values contain [1m]', () => {
    const input = [
      '[feishu]',
      'app_id = "x"',
      '',
      '[token_source.glm]',
      'slots = "opus=GLM-5.3[1m],sonnet=GLM-5.3[1m]"',
      'auth_token = "secret"',
      '',
      '[notify]',
      'port = "9876"',
      '',
    ].join('\n')

    const result = removeTokenSourceSectionText(input, 'glm')
    expect(result.removed).toBe(true)
    expect(result.text).not.toContain('token_source.glm')
    expect(result.text).not.toContain('auth_token')
    expect(result.text).toContain('[notify]')
    expect(result.text).toContain('port = "9876"')
  })

  test('returns the original text when the source does not exist', () => {
    const input = '[feishu]\napp_id = "x"\n'
    expect(removeTokenSourceSectionText(input, 'missing')).toEqual({ text: input, removed: false })
  })
})
