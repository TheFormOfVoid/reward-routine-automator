// Command-line helper inside the running container:
//   rewards run      start a run now and follow it until it ends
//   rewards status   print the current status and recent runs
// It talks to the controller's local web API, so it never fights the
// scheduler over the browser.

const port = process.env.WEB_PORT || 8099
const api = `http://127.0.0.1:${port}/api`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function status() {
  return (await fetch(`${api}/status`)).json()
}

async function main() {
  const cmd = process.argv[2] || 'status'
  if (cmd === 'status') {
    const s = await status()
    console.log(`state: ${s.phase}${s.attempt ? ` (attempt ${s.attempt})` : ''}`)
    console.log(`next run: ${s.nextRunAt ? new Date(s.nextRunAt).toString() : '-'}`)
    console.log(`daily time: ${s.runTime} ${s.timezone}`)
    if (s.message) console.log(s.message)
    for (const r of s.runs.slice(0, 7)) console.log(`  ${r.day} ${r.trigger.padEnd(8)} ${r.outcome.padEnd(10)} ${r.error || r.detail || ''}`)
    return
  }
  if (cmd === 'run') {
    let seen = (await status()).logTotal
    const r = await (await fetch(`${api}/run`, { method: 'POST' })).json()
    if (!r.ok) { console.error(r.error); process.exit(1) }
    while (true) {
      await sleep(3000)
      const chunk = await (await fetch(`${api}/log?since=${seen}`)).json()
      for (const line of chunk.lines) console.log(line)
      seen = chunk.total
      const s = await status()
      if (!s.busy) process.exit(s.runs[0]?.outcome === 'success' ? 0 : 1)
    }
  }
  console.error('usage: rewards [run|status]')
  process.exit(2)
}

main().catch((e) => { console.error(`Cannot reach the controller: ${e.message}`); process.exit(1) })
