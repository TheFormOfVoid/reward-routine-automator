// The web UI: a status page with Run now / sign-in buttons, a JSON API, and a
// reverse proxy to noVNC (websockify on 127.0.0.1:6080) under /vnc/ so the
// browser screen is reachable through the same port, including through Home
// Assistant ingress.

import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'
import { log } from './log.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const NOVNC_PORT = 6080
// Home Assistant's ingress proxy always connects from this address.
const HA_INGRESS_IP = '172.30.32.2'

function clientIp(req) {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
}

function authorized(cfg, req) {
  const ip = clientIp(req)
  if (ip === '127.0.0.1' || ip === '::1') return true
  if (cfg.haAddon) return ip === HA_INGRESS_IP
  if (!cfg.webPassword) return true
  const header = req.headers.authorization || ''
  if (!header.startsWith('Basic ')) return false
  const [, pass = ''] = Buffer.from(header.slice(6), 'base64').toString().split(/:(.*)/s)
  const a = Buffer.from(pass)
  const b = Buffer.from(cfg.webPassword)
  return a.length === b.length && timingSafeEqual(a, b)
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function proxyHttp(req, res, target) {
  const up = http.request({ host: '127.0.0.1', port: NOVNC_PORT, method: req.method, path: target, headers: { ...req.headers, host: `127.0.0.1:${NOVNC_PORT}` } }, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers)
    upRes.pipe(res)
  })
  up.on('error', () => send(res, 502, 'noVNC is not running', 'text/plain'))
  req.pipe(up)
}

function proxyUpgrade(req, socket, head, target) {
  const up = net.connect(NOVNC_PORT, '127.0.0.1', () => {
    const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${k === 'host' ? `127.0.0.1:${NOVNC_PORT}` : v}`)
    up.write(`${req.method} ${target} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
    if (head?.length) up.write(head)
    up.pipe(socket)
    socket.pipe(up)
  })
  const end = () => { up.destroy(); socket.destroy() }
  up.on('error', end)
  socket.on('error', end)
}

export function startWebServer(cfg, actions) {
  const page = fs.readFileSync(path.join(here, 'ui.html'))

  const server = http.createServer(async (req, res) => {
    if (!authorized(cfg, req)) {
      res.writeHead(401, cfg.haAddon ? {} : { 'WWW-Authenticate': 'Basic realm="Reward Routine"' })
      return res.end('Unauthorized')
    }
    const url = new URL(req.url, 'http://x')
    try {
      if (url.pathname.startsWith('/vnc/')) return proxyHttp(req, res, url.pathname.slice(4) + url.search)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, page, 'text/html; charset=utf-8')
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true })
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, actions.status())
      if (req.method === 'GET' && url.pathname === '/api/log') return send(res, 200, actions.logSince(Number(url.searchParams.get('since')) || 0))
      if (req.method === 'POST') {
        const route = {
          '/api/run': actions.runNow,
          '/api/login/open': actions.openLogin,
          '/api/login/check': actions.checkLogin,
          '/api/browser/close': actions.closeBrowser,
          '/api/notify/test': actions.testNotify,
        }[url.pathname]
        if (route) return send(res, 200, await route())
      }
      send(res, 404, { ok: false, error: 'Not found' })
    } catch (e) {
      log.error(`Web ${req.method} ${url.pathname}: ${e.message}`)
      send(res, 500, { ok: false, error: e.message })
    }
  })

  server.on('upgrade', (req, socket, head) => {
    if (!authorized(cfg, req)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith('/vnc/')) { socket.destroy(); return }
    proxyUpgrade(req, socket, head, url.pathname.slice(4) + url.search)
  })

  server.on('error', (e) => log.error(`Web UI could not start on port ${cfg.webPort}: ${e.message}`))
  server.listen(cfg.webPort, '0.0.0.0', () => log.info(`Web UI on port ${cfg.webPort}`))
  return server
}
