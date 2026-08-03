import { describe, expect, test } from 'bun:test'

import { extractAskUsrMarkers, extractSendMarkerPaths, normalizeOutboundPath, stripAskUsrMarkers } from './outbound-markers'

describe('outbound send markers', () => {
  test('extracts paths that contain square brackets', () => {
    const text = '[[send: /home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png]]'

    expect(extractSendMarkerPaths(text)).toEqual([
      '/home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png',
    ])
  })

  test('extracts multiple markers and trims marker padding', () => {
    const text = [
      'first [[send:  /tmp/a.png  ]]',
      'second [[send: /tmp/out[1].jpg]]',
    ].join('\n')

    expect(extractSendMarkerPaths(text)).toEqual([
      '/tmp/a.png',
      '/tmp/out[1].jpg',
    ])
  })

  test('does not match markers split across lines', () => {
    expect(extractSendMarkerPaths('[[send: /tmp/a.png\n]]')).toEqual([])
  })
})

describe('host askusr markers', () => {
  test('extracts askusr payloads as raw marker and payload text', () => {
    const text = 'before [[askusr: {"question":"A?","options":[{"label":"Yes"}]}]] after'

    expect(extractAskUsrMarkers(text)).toEqual([
      {
        raw: '[[askusr: {"question":"A?","options":[{"label":"Yes"}]}]]',
        payload: '{"question":"A?","options":[{"label":"Yes"}]}',
      },
    ])
  })

  test('strips askusr markers without touching surrounding text', () => {
    const text = 'a [[askusr: {"question":"A?"}]] b'

    expect(stripAskUsrMarkers(text, '[ASK]')).toBe('a [ASK] b')
  })

  test('does not match askusr markers split across lines', () => {
    expect(extractAskUsrMarkers('[[askusr: {"question":"A?"}\n]]')).toEqual([])
  })
})

describe('normalizeOutboundPath', () => {
  test('win32: rewrites MSYS drive prefix to native path', () => {
    expect(normalizeOutboundPath('/c/Users/maoxiandao2/winctl_screen.jpg', 'win32'))
      .toBe('C:\\Users\\maoxiandao2\\winctl_screen.jpg')
    expect(normalizeOutboundPath('/d/projects/a/b.png', 'win32'))
      .toBe('D:\\projects\\a\\b.png')
  })

  test('win32: leaves native Windows paths untouched', () => {
    expect(normalizeOutboundPath('C:\\Users\\a\\x.jpg', 'win32')).toBe('C:\\Users\\a\\x.jpg')
    expect(normalizeOutboundPath('C:/Users/a/x.jpg', 'win32')).toBe('C:/Users/a/x.jpg')
  })

  test('win32: leaves non-drive POSIX absolutes untouched', () => {
    expect(normalizeOutboundPath('/home/a/x.jpg', 'win32')).toBe('/home/a/x.jpg')
    expect(normalizeOutboundPath('/tmp/a', 'win32')).toBe('/tmp/a')
    expect(normalizeOutboundPath('/usr/bin/x', 'win32')).toBe('/usr/bin/x')
  })

  test('non-win32: no-op even for MSYS-looking paths', () => {
    expect(normalizeOutboundPath('/c/Users/a/x.jpg', 'linux')).toBe('/c/Users/a/x.jpg')
    expect(normalizeOutboundPath('/c/Users/a/x.jpg', 'darwin')).toBe('/c/Users/a/x.jpg')
  })
})
