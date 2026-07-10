import { useState, useRef, useEffect } from 'react'
import { useMirrorLoading } from 'shared-loading-indicator'
import { useStorageBackedState } from 'use-storage-backed-state'
import PrinterSelect, { type DiscoveredPrinter, type UiPrinter } from './PrinterSelect'
import './App.css'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

// Czech pluralization: [1, 2–4, 5+ / 0]. e.g. czPlural(2, ['fotka','fotky','fotek'])
function czPlural(n: number, forms: [string, string, string]): string {
  if (n === 1) return forms[0]
  if (n >= 2 && n <= 4) return forms[1]
  return forms[2]
}

interface ImageItem {
  file: File
  preview: string
  rotation: number
}

interface PrintProgress {
  current: number
  total: number
  name: string
}

interface SavedPrinter {
  ip: string
  name: string
}

interface JobLogEntry {
  id: number
  at: number
  source: 'ipp' | 'web' | 'test'
  printerIp: string
  name: string
  pages?: number
  status: 'ok' | 'error'
  error?: string
}

async function applyRotation(file: File, degrees: number): Promise<Blob> {
  if (degrees === 0) return file
  const img = await createImageBitmap(file)
  const swap = degrees % 180 !== 0
  const w = swap ? img.height : img.width
  const h = swap ? img.width : img.height
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.translate(w / 2, h / 2)
  ctx.rotate((degrees * Math.PI) / 180)
  ctx.drawImage(img, -img.width / 2, -img.height / 2)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b!), file.type || 'image/jpeg'))
}

export default function App() {
  const [ip, setIp] = useStorageBackedState({ key: 'printer-ip', defaultValue: '' })
  const [copies, setCopies] = useState(1)
  const [items, setItems] = useState<ImageItem[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [progress, setProgress] = useState<PrintProgress | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [saved, setSaved] = useState<SavedPrinter[]>([])
  const [paperWidthDots, setPaperWidthDots] = useState(576)
  const [jobs, setJobs] = useState<JobLogEntry[]>([])
  // The IP that OS/system print jobs (via the virtual printer) are forwarded to.
  const [starredIp, setStarredIp] = useState('')
  const [testMsg, setTestMsg] = useState('')
  const [testing, setTesting] = useState(false)
  // Live reachability of the system-print target (from /health).
  const [targetReachable, setTargetReachable] = useState<boolean | null>(null)

  // Feed print activity into the shared top-edge loading indicator.
  useMirrorLoading(status === 'loading' || testing)
  const [pageDragging, setPageDragging] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounter = useRef(0)
  const isReordering = useRef(false)
  const reorderDragIndex = useRef<number | null>(null)

  const esRef = useRef<EventSource | null>(null)

  function refreshJobs() {
    fetch(`${BACKEND_URL}/jobs`)
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => setJobs(Array.isArray(d.jobs) ? d.jobs : []))
      .catch(() => {})
  }

  function refreshHealth() {
    fetch(`${BACKEND_URL}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => setTargetReachable(h?.printer?.ip ? Boolean(h.printer.reachable) : null))
      .catch(() => {})
  }
  // Poll the target printer's online/offline status.
  useEffect(() => {
    refreshHealth()
    const id = setInterval(refreshHealth, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load config (starred printer, paper size), saved printers and recent jobs.
  useEffect(() => {
    fetch(`${BACKEND_URL}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return
        if (cfg.paperWidthDots) setPaperWidthDots(cfg.paperWidthDots)
        if (cfg.printerIp) {
          setStarredIp(cfg.printerIp)
          if (!ip) setIp(cfg.printerIp)
        }
      })
      .catch(() => {})
    fetch(`${BACKEND_URL}/printers`)
      .then((r) => (r.ok ? r.json() : { printers: [] }))
      .then((d) => setSaved(Array.isArray(d.printers) ? d.printers : []))
      .catch(() => {})
    refreshJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Star an IP as the destination for system print jobs (Cmd/Ctrl+P via the
  // virtual printer). Persisted server-side because IPP jobs carry no IP.
  function starIp(target: string) {
    const value = target.trim()
    if (!value) return
    setStarredIp(value)
    setIp(value)
    setTargetReachable(null)
    fetch(`${BACKEND_URL}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ printerIp: value }),
    })
      .then(() => setTimeout(refreshHealth, 1200)) // let the backend re-probe the new target
      .catch(() => {})
  }

  // Live discovery over SSE: printers appear as they are found (mDNS instantly,
  // port scan trickles in) rather than blocking on the whole sweep.
  function discoverPrinters() {
    esRef.current?.close()
    setDiscovered([])
    setDiscovering(true)
    const es = new EventSource(`${BACKEND_URL}/discover/stream`)
    esRef.current = es
    es.addEventListener('printer', (e) => {
      const p = JSON.parse((e as MessageEvent).data) as DiscoveredPrinter
      setDiscovered((prev) => {
        const existing = prev.find((x) => x.ip === p.ip)
        const merged: DiscoveredPrinter = {
          ...existing,
          ...p,
          name: p.name ?? existing?.name,
          verified: p.verified || existing?.verified,
        }
        return [...prev.filter((x) => x.ip !== p.ip), merged]
      })
    })
    const stop = () => {
      setDiscovering(false)
      es.close()
      if (esRef.current === es) esRef.current = null
    }
    es.addEventListener('done', stop)
    es.onerror = stop
  }
  useEffect(() => {
    discoverPrinters()
    return () => esRef.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Auto-star the first discovered printer (preferring mDNS ones) as the system
  // print target when nothing is starred yet. Never overrides a manual choice.
  useEffect(() => {
    if (starredIp || discovered.length === 0) return
    const pick = discovered.find((p) => p.source === 'mdns') ?? discovered[0]
    if (pick) starIp(pick.ip)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discovered, starredIp])

  // Rename (and thereby save) a printer, or remove a saved one.
  function renamePrinter(target: string, name: string) {
    fetch(`${BACKEND_URL}/printers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: target, name }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.printers && setSaved(d.printers))
      .catch(() => {})
  }
  function removeSavedPrinter(target: string) {
    fetch(`${BACKEND_URL}/printers`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: target }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d?.printers && setSaved(d.printers))
      .catch(() => {})
  }
  function changePaperWidth(dots: number) {
    setPaperWidthDots(dots)
    fetch(`${BACKEND_URL}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paperWidthDots: dots }),
    }).catch(() => {})
  }

  // Merge saved + live-discovered + the current/starred IP into one list.
  const mergedPrinters: UiPrinter[] = (() => {
    const byIp = new Map<string, UiPrinter>()
    for (const s of saved) byIp.set(s.ip, { ip: s.ip, name: s.name, source: 'saved', online: false, saved: true })
    for (const d of discovered) {
      const ex = byIp.get(d.ip)
      byIp.set(d.ip, {
        ip: d.ip,
        name: ex?.name ?? d.name,
        source: ex?.saved ? 'saved' : d.source,
        verified: d.verified,
        online: true,
        saved: ex?.saved ?? false,
      })
    }
    for (const extra of [starredIp, ip]) {
      if (extra && IPV4.test(extra) && !byIp.has(extra)) {
        byIp.set(extra, { ip: extra, source: 'manual', online: false, saved: false })
      }
    }
    return [...byIp.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }))
  })()

  // Print a text test receipt (name + IP) so the user can confirm which physical
  // device an IP belongs to.
  async function printTest(ip: string, name?: string) {
    setTesting(true)
    setTestMsg(`Posílám testovací lístek na ${ip}…`)
    try {
      const res = await fetch(`${BACKEND_URL}/print-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, name }),
      })
      const d = await res.json().catch(() => ({}))
      setTestMsg(res.ok && d.ok ? `Testovací lístek odeslán na ${ip} ✓` : `Tisk na ${ip} selhal: ${d.error ?? 'chyba'}`)
    } catch {
      setTestMsg(`Nepodařilo se odeslat test na ${ip}`)
    } finally {
      setTesting(false)
      refreshJobs()
    }
  }

  async function printTestAll() {
    setTesting(true)
    setTestMsg('Posílám testovací lístek na všechny nalezené tiskárny…')
    try {
      const res = await fetch(`${BACKEND_URL}/print-test-all`, { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      const results: { ok: boolean }[] = Array.isArray(d.results) ? d.results : []
      const ok = results.filter((r) => r.ok).length
      setTestMsg(`Testovací lístek odeslán na ${ok} z ${results.length} ${results.length === 1 ? 'tiskárny' : 'tiskáren'}`)
    } catch {
      setTestMsg('Nepodařilo se odeslat testy')
    } finally {
      setTesting(false)
      refreshJobs()
    }
  }

  function addFiles(files: FileList | File[]) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    setItems((prev) => [
      ...prev,
      ...imageFiles.map((file) => ({ file, preview: URL.createObjectURL(file), rotation: 0 })),
    ])
  }

  function removeImage(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  function rotateImage(index: number) {
    setItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, rotation: (item.rotation + 90) % 360 } : item))
    )
  }

  // Page-level file drag & drop
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.clipboardData?.files.length) addFiles(e.clipboardData.files)
    }
    function onDragEnter(e: DragEvent) {
      if (isReordering.current) return
      e.preventDefault()
      dragCounter.current++
      setPageDragging(true)
    }
    function onDragOver(e: DragEvent) {
      if (isReordering.current) return
      e.preventDefault()
    }
    function onDragLeave() {
      if (isReordering.current) return
      dragCounter.current--
      if (dragCounter.current <= 0) {
        dragCounter.current = 0
        setPageDragging(false)
      }
    }
    function onDrop(e: DragEvent) {
      if (isReordering.current) return
      e.preventDefault()
      dragCounter.current = 0
      setPageDragging(false)
      if (e.dataTransfer?.files) addFiles(e.dataTransfer.files)
    }
    document.addEventListener('paste', onPaste)
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
    }
  }, [])

  // Reorder handlers
  function onItemDragStart(e: React.DragEvent, index: number) {
    isReordering.current = true
    reorderDragIndex.current = index
    e.dataTransfer.effectAllowed = 'move'
  }

  function onItemDragOver(e: React.DragEvent, index: number) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverIndex(index)
  }

  function onItemDrop(e: React.DragEvent, toIndex: number) {
    e.preventDefault()
    e.stopPropagation()
    const fromIndex = reorderDragIndex.current
    if (fromIndex !== null && fromIndex !== toIndex) {
      setItems((prev) => {
        const next = [...prev]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, moved)
        return next
      })
    }
    setDragOverIndex(null)
  }

  function onItemDragEnd() {
    isReordering.current = false
    reorderDragIndex.current = null
    setDragOverIndex(null)
    dragCounter.current = 0
    setPageDragging(false)
  }

  async function handleSubmit(e: { preventDefault(): void }) {
    e.preventDefault()
    if (!IPV4.test(ip) || items.length === 0) return

    setStatus('loading')
    setErrorMsg('')
    setProgress(null)

    const formData = new FormData()
    formData.append('ip', ip)
    formData.append('copies', String(copies))
    for (const item of items) {
      const blob = await applyRotation(item.file, item.rotation)
      formData.append('images', blob, item.file.name)
    }

    try {
      const res = await fetch(`${BACKEND_URL}/print`, { method: 'POST', body: formData })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error((data as { error?: string }).error ?? 'Print failed')
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()!
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line)
          if (event.type === 'progress') {
            setProgress({ current: event.current, total: event.total, name: event.name })
          } else if (event.type === 'error') {
            throw new Error(event.message)
          }
        }
      }
      setStatus('success')
      setProgress(null)
      refreshJobs()
    } catch (err) {
      setStatus('error')
      setProgress(null)
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
      refreshJobs()
    }
  }

  // Prefer a friendly (saved/discovered) name for the starred printer.
  const starredMatch = mergedPrinters.find((p) => p.ip === starredIp)
  const starredLabel = starredMatch?.name ? `${starredMatch.name} (${starredIp})` : starredIp

  return (
    <>
      {pageDragging && (
        <div
          className="drag-overlay"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
        >
          <p>Pustit pro přidání obrázků</p>
        </div>
      )}
      <main>
        <h1>Tisk na Epson</h1>
        <form onSubmit={handleSubmit}>
          <label>
            IP adresa tiskárny
            <PrinterSelect
              value={ip}
              onChange={setIp}
              printers={mergedPrinters}
              discovering={discovering}
              onRefresh={discoverPrinters}
              starredIp={starredIp}
              onStar={starIp}
              onTest={printTest}
              onTestAll={printTestAll}
              onRename={renamePrinter}
              onRemove={removeSavedPrinter}
            />
            <small className="system-target">
              {starredIp ? (
                <>
                  Systémový tisk (Cmd/Ctrl+P) míří na <strong>★ {starredLabel}</strong>
                  {targetReachable !== null && (
                    <span className={`reach-badge ${targetReachable ? 'online' : 'offline'}`}>
                      {targetReachable ? 'online' : 'offline'}
                    </span>
                  )}
                </>
              ) : (
                <>Označ tiskárnu hvězdičkou — na ni pak míří tisk přes systém (Cmd/Ctrl+P).</>
              )}
            </small>
            {testMsg && <small className="test-msg">{testMsg}</small>}
          </label>

          <label className="paper-size">
            Šířka papíru
            <select value={paperWidthDots} onChange={(e) => changePaperWidth(Number(e.target.value))}>
              <option value={576}>80 mm (576 bodů)</option>
              <option value={384}>58 mm (384 bodů)</option>
            </select>
          </label>

          <div className="drop-zone" onClick={() => fileInputRef.current?.click()}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => e.target.files && addFiles(e.target.files)}
              style={{ display: 'none' }}
            />
            <p>
              Přetáhněte obrázky kamkoliv, vložte z clipboardu nebo{' '}
              <span className="link">vyberte ze souborů</span>
            </p>
          </div>

          {items.length > 0 && (
            <>
              <ul className="preview-grid">
                {items.map((item, i) => (
                  <li
                    key={item.preview}
                    draggable
                    className={dragOverIndex === i ? 'drag-over' : ''}
                    onDragStart={(e) => onItemDragStart(e, i)}
                    onDragOver={(e) => onItemDragOver(e, i)}
                    onDrop={(e) => onItemDrop(e, i)}
                    onDragEnd={onItemDragEnd}
                  >
                    <div className="preview-img-wrap">
                      <img
                        src={item.preview}
                        alt={item.file.name}
                        style={{ transform: `rotate(${item.rotation}deg)` }}
                      />
                    </div>
                    <div className="preview-actions">
                      <button type="button" className="action-btn" onClick={() => rotateImage(i)} title="Otočit">
                        ↻
                      </button>
                      <button type="button" className="action-btn remove" onClick={() => removeImage(i)} title="Odebrat">
                        ×
                      </button>
                    </div>
                    <span className="preview-name" title={item.file.name}>
                      {item.file.name}
                    </span>
                  </li>
                ))}
              </ul>
              <button type="button" className="remove-all-btn" onClick={() => setItems([])}>
                Odebrat vše
              </button>
            </>
          )}

          <label>
            Počet výtisků
            <input
              type="number"
              value={copies}
              min={1}
              max={99}
              onChange={(e) => setCopies(Number(e.target.value))}
            />
          </label>

          <button type="submit" disabled={status === 'loading' || items.length === 0 || !IPV4.test(ip)}>
            {status === 'loading'
              ? progress
                ? `Tisknu ${progress.current}/${progress.total}…`
                : 'Připravuji…'
              : `Tisknout${items.length > 1 ? ` (${items.length} ${czPlural(items.length, ['fotka', 'fotky', 'fotek'])})` : ''}`}
          </button>
        </form>

        {status === 'success' && <p className="msg success">Odesláno do tiskárny!</p>}
        {status === 'error' && <p className="msg error">Chyba: {errorMsg}</p>}

        {jobs.length > 0 && (
          <section className="jobs">
            <div className="jobs-head">
              <h2>Poslední úlohy</h2>
              <button type="button" className="jobs-refresh" onClick={refreshJobs}>
                ↻
              </button>
            </div>
            <ul className="jobs-list">
              {jobs.slice(0, 10).map((j) => (
                <li key={j.id} className={j.status === 'error' ? 'job-error' : 'job-ok'}>
                  <span className="job-status" aria-hidden>
                    {j.status === 'ok' ? '✓' : '✕'}
                  </span>
                  <span className="job-main">
                    <span className="job-name">
                      <span className="job-source">{jobSourceLabel(j.source)}</span> {j.name}
                    </span>
                    <span className="job-meta">
                      {j.printerIp || '—'}
                      {j.status === 'error' && j.error ? ` · ${j.error}` : ''}
                    </span>
                  </span>
                  <span className="job-time">{formatTime(j.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </>
  )
}

function jobSourceLabel(source: JobLogEntry['source']): string {
  return source === 'ipp' ? 'Systém' : source === 'web' ? 'Web' : 'Test'
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
}
