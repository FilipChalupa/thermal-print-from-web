import { useEffect, useRef, useState } from 'react'

export interface DiscoveredPrinter {
  ip: string
  name?: string
  port: number
  source: 'mdns' | 'scan'
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

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
}

export default function PrinterSelect({ value, onChange, printers, discovering, onRefresh, starredIp, onStar }: Props) {
  const [open, setOpen] = useState(false)
  const [manual, setManual] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

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

  const selected = printers.find((p) => p.ip === value)
  const triggerLabel = selected?.name ?? (value || 'Vyber tiskárnu')
  // Show the IP as a subtitle only when the main line is a friendly name.
  const triggerSub = selected?.name ? value : ''

  function applyManual() {
    const ip = manual.trim()
    if (!IPV4.test(ip)) return
    onChange(ip)
    setManual('')
    setOpen(false)
  }

  return (
    <div className="printer-select" ref={rootRef}>
      <button
        type="button"
        className="ps-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="ps-trigger-text">
          <span className="ps-trigger-name">
            {value && value === starredIp && <span className="ps-star-badge">★</span>}
            {triggerLabel}
          </span>
          {triggerSub && <span className="ps-trigger-ip">{triggerSub}</span>}
        </span>
        <span className={`ps-caret${open ? ' open' : ''}`} aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="ps-panel" role="listbox">
          <div className="ps-head">
            <span>Tiskárny v síti</span>
            <button type="button" className="ps-refresh" onClick={onRefresh} disabled={discovering}>
              {discovering ? 'Hledám…' : '↻ Vyhledat'}
            </button>
          </div>

          <ul className="ps-list">
            {printers.map((p) => {
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
                      <span className="ps-name">{p.name ?? 'Termální tiskárna'}</span>
                      <span className="ps-ip">{p.ip}</span>
                    </span>
                    {isSelected && <span className="ps-check" aria-hidden>✓</span>}
                  </button>
                  <button
                    type="button"
                    className={`ps-star${isStarred ? ' is-starred' : ''}`}
                    onClick={() => onStar(p.ip)}
                    title="Nastavit jako cíl systémového tisku (Cmd/Ctrl+P)"
                    aria-label={`Nastavit ${p.ip} jako cíl systémového tisku`}
                  >
                    {isStarred ? '★' : '☆'}
                  </button>
                </li>
              )
            })}
            {printers.length === 0 && (
              <li className="ps-empty">{discovering ? 'Hledám tiskárny…' : 'Žádná tiskárna nenalezena'}</li>
            )}
          </ul>

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
