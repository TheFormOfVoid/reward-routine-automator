// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
// No dependencies, so the runtime image needs no npm install.

export class CdpError extends Error {}

export class Cdp {
  static async connect(wsUrl, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError(`CDP connect timed out: ${wsUrl}`)), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new CdpError(`CDP connect failed: ${wsUrl}`)) }, { once: true })
    })
    return new Cdp(ws)
  }

  constructor(ws) {
    this.ws = ws
    this.nextId = 1
    this.pending = new Map()
    this.closed = false
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(String(event.data)) } catch { return }
      if (msg.id == null) return
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new CdpError(`${waiter.method}: ${msg.error.message}`))
      else waiter.resolve(msg.result)
    })
    ws.addEventListener('close', () => {
      this.closed = true
      for (const waiter of this.pending.values()) waiter.reject(new CdpError('CDP connection closed'))
      this.pending.clear()
    })
  }

  send(method, params = {}, { sessionId, timeoutMs = 30000 } = {}) {
    if (this.closed) return Promise.reject(new CdpError('CDP connection closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  }

  // Evaluate an async function's source in a target session and return its
  // JSON-serializable result.
  async evaluate(sessionId, fnSource, arg, { timeoutMs = 30000 } = {}) {
    const expression = `(${fnSource})(${JSON.stringify(arg ?? null)})`
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, { sessionId, timeoutMs })
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text
      throw new CdpError(`Page script failed: ${text}`)
    }
    return res.result?.value
  }

  close() {
    try { this.ws.close() } catch {}
  }
}
