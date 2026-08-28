import { describe, expect, test } from 'bun:test'
import { deleteTasklistRemoteIdempotently, isTasklistAlreadyDeletedError } from './tasklist'

describe('basic tasklist lifecycle', () => {
  test('treats only Feishu not-found as an already committed deletion', async () => {
    expect(isTasklistAlreadyDeletedError({ code: 1470404 })).toBe(true)
    expect(isTasklistAlreadyDeletedError(new Error('failed code=1470404 msg=not found'))).toBe(true)
    expect(isTasklistAlreadyDeletedError({ code: 500 })).toBe(false)
    await expect(deleteTasklistRemoteIdempotently('tl', async () => { throw { code: 1470404 } }))
      .resolves.toBe('already_deleted')
  })

  test('surfaces all other remote delete failures', async () => {
    await expect(deleteTasklistRemoteIdempotently('tl', async () => { throw new Error('permission denied') }))
      .rejects.toThrow('permission denied')
  })
})
