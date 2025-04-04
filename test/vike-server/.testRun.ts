export { testRun }

import {
  autoRetry,
  editFile,
  editFileRevert,
  expect,
  expectLog,
  fetch,
  fetchHtml,
  getServerUrl,
  page,
  run,
  sleep,
  test
} from '@brillout/test-e2e'

function testRun(
  cmd: 'pnpm run dev' | 'pnpm run prod',
  options?: { skipServerHMR?: boolean; https?: boolean; isFlaky?: boolean; noServerHook?: boolean }
) {
  run(cmd, {
    serverUrl: options?.https ? 'https://localhost:3000' : 'http://127.0.0.1:3000',
    isFlaky: options?.isFlaky
  })
  const entry = `./server/index-${process.env.VIKE_NODE_FRAMEWORK || 'hono'}.ts`
  const isProd = cmd === 'pnpm run prod'

  test('HTML', async () => {
    const html = await fetchHtml('/')
    expect(html).toContain('<h1>To-do List</h1>')
    expect(html).toContain('<li>Buy milk</li>')
    expect(html).toContain('<li>Buy strawberries</li>')
    // provided through pageContext function
    expect(html).toContain('x-runtime')
    expectOnReadyLog()
    if (!options?.noServerHook) {
      expectNodeServerLog('Server')
    }
  })

  test('Add to-do item', async () => {
    if (isProd && process.env.VIKE_NODE_FRAMEWORK === 'h3') {
      // h3 handles streaming very poorly, so we have to preload the page for now
      // See https://github.com/unjs/h3/issues/986
      page.goto(`${getServerUrl()}/`)
      await sleep(300)
    }

    await page.goto(`${getServerUrl()}/`)
    {
      const text = await page.textContent('body')
      expect(text).toContain('To-do List')
      expect(text).toContain('Buy milk')
      expect(text).toContain('Buy strawberries')
    }

    // Await hydration
    expect(await page.textContent('button[type="button"]')).toBe('Counter 0')
    await autoRetry(async () => {
      await page.click('button[type="button"]')
      expect(await page.textContent('button[type="button"]')).toContain('Counter 1')
    })

    // Await suspense boundary (for examples/react-streaming)
    await autoRetry(async () => {
      expect(await page.textContent('body')).toContain('Buy milk')
    })
    await page.fill('input[type="text"]', 'Buy bananas')
    await page.click('button[type="submit"]')
    await autoRetry(async () => {
      expect(await getNumberOfItems()).toBe(4)
    })
    expect(await page.textContent('body')).toContain('Buy bananas')
    if (!isProd && options?.skipServerHMR) {
      // ignore logs
      expectLog('')
    }
  })

  test('New to-do item is persisted & rendered to HTML', async () => {
    const html = await fetchHtml('/')
    expect(html).toContain('<li>Buy bananas</li>')
  })

  test('redirect throw', async () => {
    const response: Response = await fetch(`${getServerUrl()}/guarded`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${getServerUrl()}/`)
  })

  test('redirect config', async () => {
    {
      const response: Response = await fetch(`${getServerUrl()}/about-redirect`, { redirect: 'manual' })
      expect(response.status).toBe(301)
      expect(response.headers.get('location')).toBe(`${getServerUrl()}/about`)
    }
    {
      const response: Response = await fetch(`${getServerUrl()}/external-redirect`, { redirect: 'manual' })
      expect(response.status).toBe(301)
      expect(response.headers.get('location')).toBe('https://vike.dev/')
    }
  })

  test('argon2', async () => {
    await page.goto(`${getServerUrl()}/argon2`)
    expect(await page.textContent('button[type="submit"]')).toBe('Sign in')
    await autoRetry(async () => {
      await page.fill('input[type="text"]', '')
      await page.fill('input[type="text"]', 'correct-password')
      await page.click('button[type="submit"]')
      expect(await page.textContent('body')).toContain('Valid password')
    })
    if (!isProd && options?.skipServerHMR) {
      // ignore logs
      expectLog('')
    }
  })

  test('sharp', async () => {
    await page.goto(`${getServerUrl()}/sharp`)
    expect(await page.textContent('button[type="button"]')).toBe('Run sharp')
    await autoRetry(async () => {
      await page.click('button[type="button"]')
      expect(await page.textContent('body')).toContain('240000 bytes')
    })
    if (!isProd && options?.skipServerHMR) {
      // ignore logs
      expectLog('')
    }
  })

  test('x-test header is present', async () => {
    const response = await page.goto(`${getServerUrl()}/`)
    const xTestHeader = await response.headerValue('x-test')
    expect(xTestHeader).toBe('test')
  })

  if (!isProd && !options?.skipServerHMR) {
    test('vite hmr websocket', async () => {
      await page.goto(`${getServerUrl()}/`)

      // Wait for the connection message
      await autoRetry(async () => {
        expectLog('[vite] connected.')
      })
    })

    test('vike-server server-side HMR (server-entry)', async () => {
      await page.goto(`${getServerUrl()}/`)

      expect(await page.textContent('h3')).toBe('x-runtime')

      editFile(entry, (content) => content.replaceAll('x-runtime', 'x-runtime-edited'))

      await autoRetry(async () => {
        expect(await page.textContent('h3')).toBe('x-runtime-edited')
      })
      await sleep(300)
      editFileRevert()
      await autoRetry(async () => {
        expect(await page.textContent('h3')).toBe('x-runtime')
      })
      // ignore logs
      expectLog('')
    })

    test('vike-server server-side HMR (+middleware)', async () => {
      const dummyMiddlewarePath = './pages/middlewareDummy.ts'
      {
        const response: Response = await fetch(`${getServerUrl()}/dummy`)

        expect(await response.text()).toBe('OK')
      }

      editFile(dummyMiddlewarePath, (content) => content.replaceAll('OK', 'OK-edited'))

      await autoRetry(async () => {
        {
          const response: Response = await fetch(`${getServerUrl()}/dummy`)

          expect(await response.text()).toBe('OK-edited')
        }
      })
      await sleep(300)
      editFileRevert()
      await autoRetry(async () => {
        {
          const response: Response = await fetch(`${getServerUrl()}/dummy`)

          expect(await response.text()).toBe('OK')
        }
      })
      // ignore logs
      expectLog('')
    })
  }

  if (isProd)
    test('Compression and headers in production', async () => {
      const response = await page.goto(`${getServerUrl()}/`)
      const contentEncoding = await response.headerValue('content-encoding')
      expect(contentEncoding).toBe('gzip')
      const varyHeader = await response.headerValue('vary')
      expect(varyHeader).toContain('Accept-Encoding')
    })
}

async function getNumberOfItems() {
  return await page.evaluate(() => document.querySelectorAll('li').length)
}

function expectOnReadyLog() {
  expectLog('HOOK CALLED: onReady', {
    filter(logEntry) {
      return logEntry.logSource === 'stdout'
    },
    allLogs: true
  })
}

function expectNodeServerLog(serverType: 'Server') {
  expectLog(`HOOK CALLED: onCreate: ${serverType}`, {
    filter(logEntry) {
      return logEntry.logSource === 'stdout'
    },
    allLogs: true
  })
}
