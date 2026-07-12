import { useState } from 'react'

export interface NetworkPrinter {
  id: string
  name: string
  ip: string
  port: number
  uuid: string
}

export interface DiscoveredPrinter {
  ip: string
  name?: string
  port: number
  source: 'mdns' | 'scan' | 'manual'
  verified?: boolean
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

function PrinterIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 9V2h12v7" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  )
}

interface Props {
  printers: NetworkPrinter[]
  defaultPrinterId: string
  discovered: DiscoveredPrinter[]
  discovering: boolean
  onRefresh: () => void
  targetReachable: boolean | null
  defaultBadge: { cls: 'online' | 'offline'; label: string } | null
  onSetDefault: (id: string) => void
  onRename: (id: string, name: string) => void
  onRemove: (id: string) => void
  onTest: (ip: string, name: string, port: number) => void
  onAdd: (name: string, ip: string, port: number) => void
}

export default function Printers({
  printers,
  defaultPrinterId,
  discovered,
  discovering,
  onRefresh,
  targetReachable,
  defaultBadge,
  onSetDefault,
  onRename,
  onRemove,
  onTest,
  onAdd,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [manualName, setManualName] = useState('')
  const [manualIp, setManualIp] = useState('')
  const [manualPort, setManualPort] = useState('')

  const configuredIps = new Set(printers.map((p) => p.ip))
  const suggestions = discovered.filter((d) => !configuredIps.has(d.ip))
  const onlineIps = new Set(discovered.map((d) => d.ip))

  const isOnline = (p: NetworkPrinter) => onlineIps.has(p.ip) || (p.id === defaultPrinterId && targetReachable === true)

  function commitRename() {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
    setDraft('')
  }

  return (
    <section className="printers card">
      <div className="printers-head">
        <h2>Tiskárny{printers.length > 0 ? ` (${printers.length})` : ''}</h2>
        <button type="button" className="printers-refresh" onClick={onRefresh} disabled={discovering}>
          {discovering ? 'Hledám…' : '↻ Vyhledat'}
        </button>
      </div>

      {printers.length === 0 && <p className="printers-empty">Zatím žádná tiskárna — přidej ji níže.</p>}

      <ul className="printers-list">
        {printers.map((p) => {
          const isDefault = p.id === defaultPrinterId
          return (
            <li key={p.id} className={isDefault ? 'is-default' : ''}>
              <button
                type="button"
                className={`p-star${isDefault ? ' on' : ''}`}
                onClick={() => onSetDefault(p.id)}
                title={isDefault ? 'Výchozí tiskárna (Cmd/Ctrl+P i web tisk)' : 'Nastavit jako výchozí'}
                aria-label="Výchozí tiskárna"
              >
                {isDefault ? '★' : '☆'}
              </button>
              <span className={`p-dot ${isOnline(p) ? 'online' : 'offline'}`} title={isOnline(p) ? 'Online' : 'Offline'} />
              {editingId === p.id ? (
                <input
                  className="p-rename"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitRename()
                    } else if (e.key === 'Escape') setEditingId(null)
                  }}
                />
              ) : (
                <span className="p-main">
                  <span className="p-name">
                    {p.name}
                    {isDefault && <span className="p-badge">výchozí</span>}
                    {isDefault && defaultBadge && <span className={`reach-badge ${defaultBadge.cls}`}>{defaultBadge.label}</span>}
                  </span>
                  <span className="p-ip">{p.port && p.port !== 9100 ? `${p.ip}:${p.port}` : p.ip}</span>
                </span>
              )}
              <button
                type="button"
                className="p-icon"
                onClick={() => {
                  setEditingId(p.id)
                  setDraft(p.name)
                }}
                title="Přejmenovat"
                aria-label={`Přejmenovat ${p.name}`}
              >
                <PencilIcon />
              </button>
              <button type="button" className="p-icon" onClick={() => onTest(p.ip, p.name, p.port)} title="Vytisknout testovací lístek" aria-label={`Test na ${p.ip}`}>
                <PrinterIcon />
              </button>
              <button type="button" className="p-icon p-remove" onClick={() => onRemove(p.id)} title="Odebrat" aria-label={`Odebrat ${p.name}`}>
                ✕
              </button>
            </li>
          )
        })}
      </ul>

      <details className="printers-add" open={printers.length === 0}>
        <summary>Přidat tiskárnu</summary>
        {suggestions.length > 0 && (
          <ul className="printers-suggest">
            {suggestions.map((d) => (
              <li key={d.ip}>
                <button type="button" onClick={() => onAdd(d.name ?? 'Termální tiskárna', d.ip, 9100)}>
                  <span className="p-plus">＋</span>
                  <span className="p-main">
                    <span className="p-name">{d.name ?? 'Termální tiskárna'}</span>
                    <span className="p-ip">{d.ip}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="printers-manual">
          <input type="text" placeholder="Název (např. Kuchyně)" value={manualName} onChange={(e) => setManualName(e.target.value)} />
          <input type="text" inputMode="numeric" placeholder="IP, např. 192.168.1.50" value={manualIp} onChange={(e) => setManualIp(e.target.value)} />
          <input
            type="text"
            inputMode="numeric"
            className="p-port-input"
            placeholder="Port (9100)"
            value={manualPort}
            onChange={(e) => setManualPort(e.target.value.replace(/\D/g, ''))}
          />
          <button
            type="button"
            disabled={!manualName.trim() || !IPV4.test(manualIp.trim())}
            onClick={() => {
              const port = manualPort.trim() ? Number(manualPort.trim()) : 9100
              onAdd(manualName.trim(), manualIp.trim(), port > 0 && port <= 65535 ? port : 9100)
              setManualName('')
              setManualIp('')
              setManualPort('')
            }}
          >
            Přidat
          </button>
        </div>
      </details>
    </section>
  )
}
