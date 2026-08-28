import { describe, expect, test } from 'bun:test'
import {
  inboundMessageResource,
  inboundResourceDownloadFailureText,
  isStaleAtReceipt,
} from './inbound-message'

describe('inbound message freshness', () => {
  test('a fresh accepted message stays fresh even when FIFO processing starts much later', () => {
    const receivedAt = 1_000_000
    const createTime = receivedAt - 1_000

    expect(isStaleAtReceipt(createTime, receivedAt, 30_000)).toBe(false)
    // Processing time is intentionally absent from the API; a 120s queue wait
    // cannot age an already-accepted message into a replay.
  })

  test('rejects a message that was already stale when accepted', () => {
    const receivedAt = 1_000_000
    expect(isStaleAtReceipt(receivedAt - 30_001, receivedAt, 30_000)).toBe(true)
  })
})

describe('inbound native message resources', () => {
  test('maps a video media message to its downloadable file resource', () => {
    expect(inboundMessageResource('media', {
      duration: 35_003,
      file_key: 'file_v2_video',
      file_name: 'clip.mp4',
      image_key: 'img_v2_thumbnail',
    })).toEqual({
      key: 'file_v2_video',
      type: 'file',
      name: 'clip.mp4',
      displayText: '(video: clip.mp4)',
    })
  })

  test('preserves existing image and file resource mappings', () => {
    expect(inboundMessageResource('image', { image_key: 'img_v2_photo' })).toEqual({
      key: 'img_v2_photo',
      type: 'image',
      displayText: '',
    })
    expect(inboundMessageResource('file', {
      file_key: 'file_v2_document',
      file_name: 'notes.pdf',
    })).toEqual({
      key: 'file_v2_document',
      type: 'file',
      name: 'notes.pdf',
      displayText: '(file: notes.pdf)',
    })
  })

  test('rejects unsupported or keyless resources', () => {
    expect(inboundMessageResource('audio', { file_key: 'file_v2_audio' })).toBeNull()
    expect(inboundMessageResource('media', { file_name: 'clip.mp4' })).toBeNull()
  })

  test('explains the 100 MB Feishu download limit without claiming it is the only cause', () => {
    expect(inboundResourceDownloadFailureText('media')).toBe(
      '❌ 收到的视频下载失败，未转交给 Agent。备注：可能是视频超过飞书消息资源 100 MB 下载上限。',
    )
  })
})
