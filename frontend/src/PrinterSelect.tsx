import { useEffect, useRef, useState } from 'react'

export interface DiscoveredPrinter {
  ip: string
  name?: string
  port: number
  source: 'mdns' | 'scan' | 'manual'
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

// Printer glyph (feather "printer") — inline SVG so it renders everywhere and
// follows the current text color in both light and dark themes.
function PrinterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  )
}

interface Props {
  /** Currently selected IP (target of the manual web print). */
  value: string
  onChange: (ip: string) => void
  printers: DiscoveredPrinter[]
  discovering: boolean
  onRefresh: () => void
  /** IP that OS/system print jobs are forwarded to. */
  starredIp: string
  onStar: (ip: string) => void
  /** Print a text test receipt to a single printer. */
  onTest: (ip: string, name?: string) => void
  /** Print a test receipt to every discovered printer. */
  onTestAll: () => void
}

export default function PrinterSelect({
  value,
  onChange,
  printers,
  discovering,
  onRefresh,
  starredIp,
  onStar,
  onTest,
  onTestAll,
}: Props) {
  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // Merge in the selected/starred IP when it isn't among the discovered ones, so
  // a manually entered (and possibly starred) printer is still visible & pickable.
  const options: DiscoveredPrinter[] = [...printers]
  const known = new Set(printers.map((p) => p.ip))
  for (const extraIp of [starredIp, value]) {
    if (extraIp && IPV4.test(extraIp) && !known.has(extraIp)) {
      known.add(extraIp)
      options.push({ ip: extraIp, port: 9100, source: 'manual' })
    }
  }
  const displayName = (p: DiscoveredPrinter) =>
    p.name ?? (p.source === 'manual' ? 'Ručně zadaná tiskárna' : 'Termální tiskárna')

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = options.find((p) => p.ip === value)
  const triggerLabel = selected ? displayName(selected) : value || 'Vyber tiskárnu'
  const triggerSub = selected ? selected.ip : ''

  function applyManual() {
    const ip = manual.trim()
    if (!IPV4.test(ip)) return
    onChange(ip)
    setManual('')
    setOpen(false)
  }

  return (
    <div className="printer-select" ref={rootRef}>
      <div className="ps-trigger">
        <button
          type="button"
          className="ps-trigger-open"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          <span className="ps-trigger-text">
            <span className="ps-trigger-name">{triggerLabel}</span>
            {triggerSub && <span className="ps-trigger-ip">{triggerSub}</span>}
          </span>
          <span className={`ps-caret${open ? ' open' : ''}`} aria-hidden>
            ▾
          </span>
        </button>
        {IPV4.test(value) && (
          <button
            type="button"
            className={`ps-star ps-trigger-star${value === starredIp ? ' is-starred' : ''}`}
            onClick={() => onStar(value)}
            title="Nastavit jako cíl systémového tisku (Cmd/Ctrl+P)"
            aria-label="Nastavit vybranou tiskárnu jako cíl systémového tisku"
          >
            {value === starredIp ? '★' : '☆'}
          </button>
        )}
      </div>

      {open && (
        <div className="ps-panel" role="listbox">
          <div className="ps-head">
            <span>Tiskárny v síti</span>
            <button type="button" className="ps-refresh" onClick={onRefresh} disabled={discovering}>
              {discovering ? 'Hledám…' : '↻ Vyhledat'}
            </button>
          </div>

          <ul className="ps-list">
            {options.map((p) => {
              const isSelected = p.ip === value
              const isStarred = p.ip === starredIp
              return (
                <li key={p.ip} className={`${isSelected ? 'selected' : ''} ${isStarred ? 'starred' : ''}`.trim()}>
                  <button
                    type="button"
                    className="ps-option"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => {
                      onChange(p.ip)
                      setOpen(false)
                    }}
                  >
                    <span className="ps-option-main">
                      <span className="ps-name">{displayName(p)}</span>
                      <span className="ps-ip">{p.ip}</span>
                    </span>
                    {isSelected && <span className="ps-check" aria-hidden>✓</span>}
                  </button>
                  <button
                    type="button"
                    className="ps-icon-btn ps-test"
                    onClick={() => onTest(p.ip, p.name)}
                    title="Vytisknout testovací lístek (název + IP)"
                    aria-label={`Vytisknout testovací lístek na ${p.ip}`}
                  >
                    <PrinterIcon />
                  </button>
                  <button
                    type="button"
                    className={`ps-icon-btn ps-star${isStarred ? ' is-starred' : ''}`}
                    onClick={() => onStar(p.ip)}
                    title="Nastavit jako cíl systémového tisku (Cmd/Ctrl+P)"
                    aria-label={`Nastavit ${p.ip} jako cíl systémového tisku`}
                  >
                    {isStarred ? '★' : '☆'}
                  </button>
                </li>
              )
            })}
            {options.length === 0 && (
              <li className="ps-empty">{discovering ? 'Hledám tiskárny…' : 'Žádná tiskárna nenalezena'}</li>
            )}
          </ul>

          {options.length > 0 && (
            <button type="button" className="ps-testall" onClick={onTestAll}>
              <PrinterIcon /> Otestovat všechny tiskárny
            </button>
          )}

          <div className="ps-manual">
            <input
              type="text"
              inputMode="numeric"
              placeholder="Zadat IP ručně, např. 192.168.1.100"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyManual()
                }
              }}
            />
            <button type="button" className="ps-manual-apply" onClick={applyManual} disabled={!IPV4.test(manual.trim())}>
              Použít
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
