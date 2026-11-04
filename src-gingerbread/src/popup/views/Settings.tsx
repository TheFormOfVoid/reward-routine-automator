import { useState } from 'react'
import type { ReactNode } from 'react'
import { motion, Reorder } from 'framer-motion'
import type { Appearance, BackgroundStyle, Settings as SettingsShape, StepId, TabCloseMode, ThemeName } from '../../shared/settings.ts'
import { DEFAULT_SETTINGS, ENABLED_KEY, STEP_LABEL } from '../../shared/settings.ts'
import { slotMissingDefaults } from '../../background/pure/orders.ts'
import { parseTimeOfDay, to12Hour, from12Hour, type Meridiem } from '../../background/pure/schedule.ts'
import { QUERY_SOURCE_LABELS as QUERY_SOURCES, DEFAULT_QUERY_SOURCE_ORDER } from '../../background/queries/metadata.ts'
import { viewVariants } from '../fx/motion-presets.ts'
import { Card } from '../components/Card.tsx'
import { Switch } from '../components/Switch.tsx'
import { Segmented } from '../components/Segmented.tsx'
import { NumberField } from '../components/NumberField.tsx'
import { Slider } from '../components/Slider.tsx'
import { BackupCard } from '../components/BackupCard.tsx'

// The popup's tabs, in the sectionOrder the layout editor arranges.
const SECTION_LABELS: Record<string, string> = {
  today: 'Today',
  runNow: 'Run',
  redeem: 'Redeem',
  activity: 'Activity',
}

const CLOSE_TOGGLES: { key: keyof SettingsShape; label: string }[] = [
  { key: 'closeTabsAfterManualRun', label: 'After a manual run' },
  { key: 'closeTabsAfterClaim', label: 'After claim' },
  { key: 'closeTabsAfterDailySet', label: 'After daily set' },
  { key: 'closeTabsAfterKeepEarning', label: 'After keep earning' },
  { key: 'closeTabsAfterSearch', label: 'After search' },
  { key: 'closeTabsAfterImageSearch', label: 'After image search' },
]

// '' is the theme's own accent; the rest override it.
const ACCENTS = ['', '#06b6d4', '#8b5cf6', '#f472b6', '#22c55e', '#f59e0b', '#0070f3', '#ef4444']

// `noEscape` marks the one row that must never flee the cursor while the
// mouse-escape troll is on — the troll's own switch (or it could never be
// turned off). Everything else in Settings dodges like the rest of the UI.
function Row({
  label,
  hint,
  noEscape,
  children,
}: {
  label: string
  hint?: string
  noEscape?: boolean
  children: ReactNode
}) {
  return (
    <div className="set-row" data-no-escape={noEscape ? '' : undefined}>
      <div className="set-row-text">
        <span className="set-label">{label}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

export function Settings({
  settings,
  save,
  motionOn,
}: {
  settings: SettingsShape
  save: (patch: Partial<SettingsShape>) => Promise<SettingsShape>
  motionOn: boolean
}) {
  // A boolean toggle helper: the computed key needs the cast to land as a
  // Partial<Settings> rather than a plain string-keyed record.
  const toggle = (key: keyof SettingsShape, next: boolean) => save({ [key]: next } as Partial<SettingsShape>)

  // While any reorder drag is live, the drag lists carry [data-escape-hold]:
  // framer's Reorder owns the rows' transform mid-drag, so the mouse-escape
  // troll freezes them for the duration instead of fighting it (user request,
  // 2026-09-11: the reorder rows should dodge the mouse like everything else —
  // they used to be wholesale-exempt).
  const [reordering, setReordering] = useState(false)

  // The scheduled time is stored "HH:MM" (24-hour) but edited on a 12-hour
  // face — hour 1–12, minute, and an AM/PM toggle (user request, 2026-09-12) —
  // the clock idiom people actually read, in the app's own field style rather
  // than the native time picker. A stored value that somehow doesn't parse
  // falls back to the 09:00 default rather than NaN.
  const scheduledMinutes = parseTimeOfDay(settings.scheduledRunTime) ?? 9 * 60
  const schedFace = to12Hour(scheduledMinutes)
  const saveScheduledTime = (h: number, m: number, mer: Meridiem): void => {
    const h24 = from12Hour(h, m, mer)
    void save({ scheduledRunTime: `${String(Math.floor(h24 / 60)).padStart(2, '0')}:${String(h24 % 60).padStart(2, '0')}` })
  }

  // The drag-reorder lists read the saved order through the same normalization
  // the worker runs (slotMissingDefaults), so what the user drags is exactly
  // what the routine runs — an id an update added is already in its default
  // slot before the first drag.
  const stepOrder = slotMissingDefaults(settings.startupOrder, DEFAULT_SETTINGS.startupOrder)
  const sourceOrder = slotMissingDefaults(settings.querySourceOrder, DEFAULT_QUERY_SOURCE_ORDER)
  const sectionOrder = slotMissingDefaults(settings.sectionOrder, DEFAULT_SETTINGS.sectionOrder)

  return (
    <motion.div className="view" variants={viewVariants} initial={motionOn ? 'initial' : false} animate="enter" exit={motionOn ? 'exit' : undefined}>
      <Card title="Appearance">
        <Row label="Mode">
          <Segmented<Appearance>
            ariaLabel="Appearance"
            value={settings.appearance}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'auto', label: 'Auto' },
            ]}
            onChange={(v) => save({ appearance: v })}
          />
        </Row>
        <Row label="Theme">
          <select
            className="select"
            value={settings.theme}
            onChange={(e) => save({ theme: e.target.value as ThemeName })}
          >
            <option value="catppuccin">Catppuccin</option>
            <option value="geist">Geist</option>
            <option value="primer">Primer</option>
            <option value="nord">Nord</option>
            <option value="dracula">Dracula</option>
            <option value="tokyo">Tokyo Night</option>
            <option value="gruvbox">Gruvbox</option>
            <option value="rose">Rosé Pine</option>
          </select>
        </Row>
        <Row label="Background" hint="The backdrop behind the popup">
          <select
            className="select"
            value={settings.background}
            onChange={(e) => save({ background: e.target.value as BackgroundStyle })}
          >
            <optgroup label="Interactive">
              <option value="constellation">Constellation</option>
              <option value="cursor">Cursor glow</option>
              <option value="particles">Particles</option>
              <option value="parallax">Parallax</option>
            </optgroup>
            <optgroup label="Drifting & glowing">
              <option value="aurora">Aurora</option>
              <option value="bokeh">Bokeh</option>
              <option value="fireflies">Fireflies</option>
              <option value="swirl">Swirl</option>
              <option value="glow">Glow</option>
            </optgroup>
            <optgroup label="Light">
              <option value="beams">Beams</option>
              <option value="rays">Light rays</option>
              <option value="spotlight">Spotlight</option>
            </optgroup>
            <optgroup label="Falling & rising">
              <option value="meteors">Meteors</option>
              <option value="snow">Snow</option>
              <option value="rain">Rain</option>
              <option value="bubbles">Bubbles</option>
            </optgroup>
            <optgroup label="Fields">
              <option value="stars">Stars</option>
              <option value="dots">Dots</option>
              <option value="grid">Grid</option>
              <option value="hex">Hexagons</option>
              <option value="checker">Checker</option>
              <option value="stripes">Stripes</option>
              <option value="mesh">Mesh</option>
            </optgroup>
            <optgroup label="Pulsing & flowing">
              <option value="ripple">Ripple</option>
              <option value="orbit">Orbit</option>
              <option value="retro">Retro grid</option>
              <option value="noise">Noise</option>
              <option value="waves">Waves</option>
            </optgroup>
            <option value="none">None</option>
          </select>
        </Row>
        <Row label="Brightness" hint="How bright the backdrop shines">
          <Slider
            value={settings.backgroundBrightness}
            min={50}
            max={150}
            step={5}
            suffix="%"
            ariaLabel="Background brightness"
            onCommit={(n) => save({ backgroundBrightness: n })}
          />
        </Row>
        <Row label="Glass blur" hint="How much cards and navigation frost the backdrop">
          <Slider
            value={settings.tileBlur}
            min={0}
            max={30}
            suffix="px"
            ariaLabel="Glass blur"
            onCommit={(n) => save({ tileBlur: n })}
          />
        </Row>
        <Row label="Top bar background" hint="Block scrolling content behind the top bar">
          <Switch checked={settings.topBarBackground} onChange={(v) => toggle('topBarBackground', v)} label="Top bar background" />
        </Row>
        <Row label="Bottom bar background" hint="Block scrolling content behind the bottom bar">
          <Switch checked={settings.bottomBarBackground} onChange={(v) => toggle('bottomBarBackground', v)} label="Bottom bar background" />
        </Row>
        <Row label="Accent" hint="Theme default, or pick a color">
          <div className="swatches">
            {ACCENTS.map((a) => (
              <button
                key={a || 'theme'}
                type="button"
                className={`swatch${settings.accentColor === a ? ' on' : ''}${a ? '' : ' swatch--theme'}`}
                style={a ? { background: a } : undefined}
                aria-label={a || 'Theme default'}
                title={a || 'Theme default'}
                onClick={() => save({ accentColor: a })}
              />
            ))}
          </div>
        </Row>
        <Row label="Animations" hint="Also honors your system reduced-motion setting">
          <Switch checked={settings.animationsEnabled} onChange={(v) => toggle('animationsEnabled', v)} label="Animations" />
        </Row>
        <Row label="Low power mode" hint="Everything stands still — overrides Animations and freezes the backdrop to a static frame">
          <Switch checked={settings.lowPowerMode} onChange={(v) => toggle('lowPowerMode', v)} label="Low power mode" />
        </Row>
      </Card>

      <Card title="Startup routine">
        <Row label="Run on browser start">
          <Switch checked={settings.startupEnabled} onChange={(v) => toggle('startupEnabled', v)} label="Run on browser start" />
        </Row>
        <Row label="Only once per day">
          <Switch checked={settings.startupOncePerDay} onChange={(v) => toggle('startupOncePerDay', v)} label="Only once per day" />
        </Row>
        <Row label="Ask before running" hint="A 15s window to cancel">
          <Switch checked={settings.confirmBeforeRoutine} onChange={(v) => toggle('confirmBeforeRoutine', v)} label="Ask before running" />
        </Row>
        <Row label="Run on a schedule" hint="Also in a browser that never closes and reopens">
          <Switch checked={settings.scheduledRunEnabled} onChange={(v) => toggle('scheduledRunEnabled', v)} label="Run on a schedule" />
        </Row>
        <Row label="Quiet hours" hint="Postpone automatic activity during this window">
          <Switch checked={settings.quietHoursEnabled} onChange={(v) => toggle('quietHoursEnabled', v)} label="Quiet hours" />
        </Row>
        {settings.quietHoursEnabled && <Row label="Quiet window" hint="Your local time; may cross midnight">
          <span className="field-inline"><input className="backup-time" type="time" aria-label="Quiet hours start" value={settings.quietHoursStart} onChange={(event) => event.target.value && save({ quietHoursStart: event.target.value })} /><span>to</span><input className="backup-time" type="time" aria-label="Quiet hours end" value={settings.quietHoursEnd} onChange={(event) => event.target.value && save({ quietHoursEnd: event.target.value })} /></span>
        </Row>}
        <Row label="Scheduled time" hint="Your local time">
          <span className="field-inline">
            <NumberField
              value={schedFace.hour}
              min={1}
              max={12}
              onCommit={(h) => saveScheduledTime(h, schedFace.minute, schedFace.meridiem)}
              ariaLabel="Scheduled hour"
            />
            <span className="field-sep">:</span>
            <NumberField
              value={schedFace.minute}
              min={0}
              max={59}
              onCommit={(m) => saveScheduledTime(schedFace.hour, m, schedFace.meridiem)}
              ariaLabel="Scheduled minute"
            />
            <Segmented<Meridiem>
              ariaLabel="AM or PM"
              value={schedFace.meridiem}
              options={[
                { value: 'AM', label: 'AM' },
                { value: 'PM', label: 'PM' },
              ]}
              onChange={(mer) => saveScheduledTime(schedFace.hour, schedFace.minute, mer)}
            />
          </span>
        </Row>
        <div className="set-subhead">Steps — drag to reorder</div>
        <Reorder.Group
          axis="y"
          values={stepOrder}
          onReorder={(next: StepId[]) => save({ startupOrder: next })}
          className="reorder-list"
          data-escape-hold={reordering ? '' : undefined}
        >
          {stepOrder.map((id) => {
            const label = STEP_LABEL[id]
            return (
              <Reorder.Item
                key={id}
                value={id}
                className="reorder-item"
                data-escape-unit
                onDragStart={() => setReordering(true)}
                onDragEnd={() => setReordering(false)}
              >
                <span className="reorder-handle" aria-hidden="true">⠿</span>
                <span className="set-label">{label}</span>
                <Switch
                  checked={Boolean(settings[ENABLED_KEY[id]])}
                  onChange={(v) => toggle(ENABLED_KEY[id], v)}
                  label={label}
                />
              </Reorder.Item>
            )
          })}
        </Reorder.Group>
      </Card>

      <Card title="Searching">
        <Row label="Prowl searches" hint="2–5 searches at a random time inside the interval">
          <Switch checked={settings.randomSearchEnabled} onChange={(v) => toggle('randomSearchEnabled', v)} label="Prowl searches" />
        </Row>
        <Row label="Prowl interval">
          <span className="field-inline">
            <NumberField
              value={settings.prowlMinIntervalMin}
              min={1}
              max={settings.prowlMaxIntervalMin}
              suffix="m"
              onCommit={(n) => save({ prowlMinIntervalMin: n })}
              ariaLabel="Prowl minimum interval"
            />
            <span className="field-sep">to</span>
            <NumberField
              value={settings.prowlMaxIntervalMin}
              min={settings.prowlMinIntervalMin}
              max={240}
              suffix="m"
              onCommit={(n) => save({ prowlMaxIntervalMin: n })}
              ariaLabel="Prowl maximum interval"
            />
          </span>
        </Row>
        <Row label="Automatic batch size" hint="Size to the points left today">
          <Switch checked={settings.rightSizeSearchBatch} onChange={(v) => toggle('rightSizeSearchBatch', v)} label="Automatic batch size" />
        </Row>
        <Row label="Searches per batch" hint="Used when automatic is off">
          <NumberField value={settings.searchesPerBatch} min={1} max={100} onCommit={(n) => save({ searchesPerBatch: n })} ariaLabel="Searches per batch" />
        </Row>
        <Row label="Delay between searches">
          <span className="field-inline">
            <NumberField value={settings.minDelaySec} min={1} max={settings.maxDelaySec} suffix="s" onCommit={(n) => save({ minDelaySec: n })} ariaLabel="Minimum delay" />
            <span className="field-sep">to</span>
            <NumberField value={settings.maxDelaySec} min={settings.minDelaySec} max={120} suffix="s" onCommit={(n) => save({ maxDelaySec: n })} ariaLabel="Maximum delay" />
          </span>
        </Row>
        <div className="set-subhead">Query sources — drag to reorder</div>
        {/* The chain's fallback order: sources earlier in the list are tried
         * first; local-fallback never fails, so it rounds the list off. */}
        <Reorder.Group
          axis="y"
          values={sourceOrder}
          onReorder={(next: string[]) => save({ querySourceOrder: next })}
          className="reorder-list"
          data-escape-hold={reordering ? '' : undefined}
        >
          {sourceOrder.map((id) => {
            const label = QUERY_SOURCES[id]?.name || id
            return (
              <Reorder.Item
                key={id}
                value={id}
                className="reorder-item"
                data-escape-unit
                onDragStart={() => setReordering(true)}
                onDragEnd={() => setReordering(false)}
              >
                <span className="reorder-handle" aria-hidden="true">⠿</span>
                <span className="set-label">{label}</span>
              </Reorder.Item>
            )
          })}
        </Reorder.Group>
      </Card>

      <Card title="Layout">
        <p className="muted small">Tabs — drag to reorder; hide the ones you don't use.</p>
        <Reorder.Group
          axis="y"
          values={sectionOrder}
          onReorder={(next: string[]) => save({ sectionOrder: next })}
          className="reorder-list"
          data-escape-hold={reordering ? '' : undefined}
        >
          {sectionOrder.map((id) => {
            const label = SECTION_LABELS[id] || id
            const hidden = settings.hiddenSections.includes(id)
            return (
              <Reorder.Item
                key={id}
                value={id}
                className="reorder-item"
                data-escape-unit
                onDragStart={() => setReordering(true)}
                onDragEnd={() => setReordering(false)}
              >
                <span className="reorder-handle" aria-hidden="true">⠿</span>
                <span className={`set-label${hidden ? ' set-label--hidden' : ''}`}>{label}</span>
                <Switch
                  checked={!hidden}
                  onChange={(v) => {
                    const next = v
                      ? settings.hiddenSections.filter((s) => s !== id)
                      : [...new Set(settings.hiddenSections.concat(id))]
                    save({ hiddenSections: next })
                  }}
                  label={`Show ${label}`}
                />
              </Reorder.Item>
            )
          })}
        </Reorder.Group>
      </Card>

      <Card title="Tabs">
        <Row label="Close opened tabs">
          <Segmented<TabCloseMode>
            ariaLabel="Tab close mode"
            value={settings.tabCloseMode}
            options={[
              { value: 'perStep', label: 'Per step' },
              { value: 'routine', label: 'At end' },
            ]}
            onChange={(v) => save({ tabCloseMode: v })}
          />
        </Row>
        <Row label="Keep pinned tabs">
          <Switch checked={settings.keepPinnedTabs} onChange={(v) => toggle('keepPinnedTabs', v)} label="Keep pinned tabs" />
        </Row>
        <Row label="Close delay" hint="Grace time so pages get credited">
          <NumberField value={settings.tabCloseDelaySec} min={0} max={60} suffix="s" onCommit={(n) => save({ tabCloseDelaySec: n })} ariaLabel="Tab close delay" />
        </Row>
        <div className="set-subhead">Close after…</div>
        {CLOSE_TOGGLES.map(({ key, label }) => (
          <Row key={key} label={label}>
            <Switch checked={Boolean(settings[key])} onChange={(v) => toggle(key, v)} label={label} />
          </Row>
        ))}
      </Card>

      <Card title="Tiles">
        <Row label="Daily set — max tiles">
          <NumberField value={settings.dailySetMaxTiles} min={1} max={10} onCommit={(n) => save({ dailySetMaxTiles: n })} ariaLabel="Daily set max tiles" />
        </Row>
        <Row label="Keep earning — max tiles" hint="0 = all of today's">
          <NumberField value={settings.keepEarningMaxTiles} min={0} max={20} onCommit={(n) => save({ keepEarningMaxTiles: n })} ariaLabel="Keep earning max tiles" />
        </Row>
      </Card>

      <Card title="Behavior">
        <Row label="Escape the mouse" hint="Every control dodges your cursor — except this switch" noEscape>
          <Switch
            checked={settings.mouseEscapeEnabled}
            onChange={(v) => toggle('mouseEscapeEnabled', v)}
            label="Escape the mouse"
          />
        </Row>
        <Row label="Refresh stats on open">
          <Switch checked={settings.refreshStatsOnPopupOpen} onChange={(v) => toggle('refreshStatsOnPopupOpen', v)} label="Refresh stats on open" />
        </Row>
        <Row label="Popup height" hint="0 = default (560); 240–600 fixes it">
          <NumberField value={settings.popupHeight} min={0} max={600} step={20} suffix="px" onCommit={(n) => save({ popupHeight: n })} ariaLabel="Popup height" />
        </Row>
      </Card>

      <Card title="Developer">
        {/* The dev gate (mirrors the other builds): while on, two extra
         * topbar buttons appear — the finish-screen opener (the dashboard
         * overlay the routine opens at its end) and the once-per-day reset —
         * so layout, wording and motion can be checked without running a
         * whole routine. */}
        <Row label="Developer options" hint="Extra buttons in the topbar">
          <Switch checked={settings.developerOptionsEnabled} onChange={(v) => toggle('developerOptionsEnabled', v)} label="Developer options" />
        </Row>
        <Row label="Experimental features" hint="Adds the Coupons button to the Run tab">
          <Switch checked={settings.experimentalFeatures} onChange={(v) => toggle('experimentalFeatures', v)} label="Experimental features" />
        </Row>
      </Card>

      <Card title="Restock watcher">
        <Row label="Watch for restocks" hint="Check the catalog between routines">
          <Switch checked={settings.restockWatcherEnabled} onChange={(v) => toggle('restockWatcherEnabled', v)} label="Watch for restocks" />
        </Row>
        {settings.restockWatcherEnabled && <Row label="Check every" hint="Minutes; quiet hours apply">
          <NumberField value={settings.restockIntervalMin} min={15} max={1440} suffix="min" onCommit={(n) => save({ restockIntervalMin: n })} ariaLabel="Restock check interval" />
        </Row>}
      </Card>
      <BackupCard />
    </motion.div>
  )
}

