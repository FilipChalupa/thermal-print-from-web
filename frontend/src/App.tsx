import { useState, useRef, useEffect } from 'react'
import { useMirrorLoading } from 'shared-loading-indicator'
import Printers, { type DiscoveredPrinter, type NetworkPrinter } from './Printers'
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

type DitherAlgorithm = 'floyd' | 'atkinson' | 'ordered' | 'threshold'

const DITHER_LABELS: Record<DitherAlgorithm, string> = {
  floyd: 'Floyd–Steinberg',
  atkinson: 'Atkinson',
  ordered: 'Ordered (rastr)',
  threshold: 'Práh (bez ditheru)',
}

interface TargetStatus {
  reachable: boolean
  online: boolean
  paperOut: boolean
  coverOpen: boolean
}

function targetBadge(t: TargetStatus | null): { cls: 'online' | 'offline'; label: string } | null {
  if (!t) return null
  if (!t.reachable) return { cls: 'offline', label: 'offline' }
  if (t.paperOut) return { cls: 'offline', label: 'došel papír' }
  if (t.coverOpen) return { cls: 'offline', label: 'otevřené víko' }
  if (!t.online) return { cls: 'offline', label: 'není připraveno' }
  return { cls: 'online', label: 'online' }
}

interface JobLogEntry {
  id: number
  at: number
  source: 'ipp' | 'web' | 'test' | 'reprint'
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
  const [copies, setCopies] = useState(1)
  const [items, setItems] = useState<ImageItem[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [progress, setProgress] = useState<PrintProgress | null>(null)
  const [printers, setPrinters] = useState<NetworkPrinter[]>([])
  const [defaultPrinterId, setDefaultPrinterId] = useState('')
  const [discovered, setDiscovered] = useState<DiscoveredPrinter[]>([])
  const [discovering, setDiscovering] = useState(false)
  const [paperWidthDots, setPaperWidthDots] = useState(576)
  const [ditherAlgorithm, setDitherAlgorithm] = useState<DitherAlgorithm>('floyd')
  const [brightness, setBrightness] = useState(0)
  const [contrast, setContrast] = useState(0)
  const [jobs, setJobs] = useState<JobLogEntry[]>([])
  const [testMsg, setTestMsg] = useState('')
  const [testing, setTesting] = useState(false)
  // Live status of the default printer (from /health).
  const [target, setTarget] = useState<TargetStatus | null>(null)

  useMirrorLoading(status === 'loading' || testing)
  const [pageDragging, setPageDragging] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounter = useRef(0)
  const isReordering = useRef(false)
  const reorderDragIndex = useRef<number | null>(null)
  const esRef = useRef<EventSource | null>(null)

  const defaultPrinter = printers.find((p) => p.id === defaultPrinterId) ?? printers[0]
  const defaultIp = defaultPrinter?.ip ?? ''

  function refreshJobs() {
    fetch(`${BACKEND_URL}/jobs`)
      .then((r) => (r.ok ? r.json() : { jobs: [] }))
      .then((d) => setJobs(Array.isArray(d.jobs) ? d.jobs : []))
      .catch(() => {})
  }

  function loadPrinters() {
    fetch(`${BACKEND_URL}/printers`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        setPrinters(Array.isArray(d.printers) ? d.printers : [])
        setDefaultPrinterId(typeof d.defaultPrinterId === 'string' ? d.defaultPrinterId : '')
      })
      .catch(() => {})
  }

  function refreshHealth() {
    fetch(`${BACKEND_URL}/health`)
      .then((r) => (r.ok ? r.json() : null))
      .then((h) => {
        const p = h?.printer
        setTarget(
          p?.ip
            ? { reachable: Boolean(p.reachable), online: Boolean(p.online), paperOut: Boolean(p.paperOut), coverOpen: Boolean(p.coverOpen) }
            : null,
        )
      })
      .catch(() => {})
  }

  useEffect(() => {
    refreshHealth()
    const id = setInterval(refreshHealth, 15000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load print settings, printers and recent jobs on mount.
  useEffect(() => {
    fetch(`${BACKEND_URL}/config`)
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        if (!cfg) return
        if (cfg.paperWidthDots) setPaperWidthDots(cfg.paperWidthDots)
        if (cfg.ditherAlgorithm) setDitherAlgorithm(cfg.ditherAlgorithm)
        if (typeof cfg.brightness === 'number') setBrightness(cfg.brightness)
        if (typeof cfg.contrast === 'number') setContrast(cfg.contrast)
      })
      .catch(() => {})
    loadPrinters()
    refreshJobs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Live discovery over SSE: printers appear as they are found.
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
        const merged: DiscoveredPrinter = { ...existing, ...p, name: p.name ?? existing?.name, verified: p.verified || existing?.verified }
        return [...prev.filter((x) => x.ip !== p.ip), merged]
      })
    })
    const stop = () => {
      setDiscovering(false)
      es.close()
      if (esRef.current === es) esRef.current = null
      loadPrinters() // pick up any printer the backend auto-added on boot
    }
    es.addEventListener('done', stop)
    es.onerror = stop
  }
  useEffect(() => {
    discoverPrinters()
    return () => esRef.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Printer management (unified list; each is its own AirPrint queue) ---
  function applyPrinters(d: { printers?: NetworkPrinter[]; defaultPrinterId?: string } | null) {
    if (!d) return
    if (Array.isArray(d.printers)) setPrinters(d.printers)
    if (typeof d.defaultPrinterId === 'string') setDefaultPrinterId(d.defaultPrinterId)
  }
  function addPrinter(name: string, ip: string) {
    fetch(`${BACKEND_URL}/printers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        applyPrinters(d)
        setTimeout(refreshHealth, 1200)
      })
      .catch(() => {})
  }
  function renamePrinter(id: string, name: string) {
    fetch(`${BACKEND_URL}/printers/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(applyPrinters)
      .catch(() => {})
  }
  function removePrinter(id: string) {
    fetch(`${BACKEND_URL}/printers/${id}`, { method: 'DELETE' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        applyPrinters(d)
        setTimeout(refreshHealth, 1200)
      })
      .catch(() => {})
  }
  function setDefault(id: string) {
    setTarget(null)
    fetch(`${BACKEND_URL}/printers/${id}/default`, { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        applyPrinters(d)
        setTimeout(refreshHealth, 1200)
      })
      .catch(() => {})
  }

  function reprintJob(id: number) {
    fetch(`${BACKEND_URL}/jobs/${id}/reprint`, { method: 'POST' })
      .then(() => setTimeout(refreshJobs, 300))
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

  // Persist image/dither settings, debounced so sliders don't spam the backend.
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function postSettings(patch: Record<string, unknown>) {
    clearTimeout(settingsTimer.current)
    settingsTimer.current = setTimeout(() => {
      fetch(`${BACKEND_URL}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => {})
    }, 300)
  }

  // Print a text test receipt so the user can confirm which device an IP is.
  async function printTest(ip: string, name: string) {
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

  function addFiles(files: FileList | File[]) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    setItems((prev) => [...prev, ...imageFiles.map((file) => ({ file, preview: URL.createObjectURL(file), rotation: 0 }))])
  }

  function removeImage(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index))
  }

  function rotateImage(index: number) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, rotation: (item.rotation + 90) % 360 } : item)))
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
    if (!IPV4.test(defaultIp) || items.length === 0) return

    setStatus('loading')
    setErrorMsg('')
    setProgress(null)

    const formData = new FormData()
    formData.append('ip', defaultIp)
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

  const badge = targetBadge(target)

  return (
    <>
      {pageDragging && (
        <div className="drag-overlay" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
          <p>Pustit pro přidání obrázků</p>
        </div>
      )}
      <main>
        <h1>Tisk na Epson</h1>

        <Printers
          printers={printers}
          defaultPrinterId={defaultPrinterId}
          discovered={discovered}
          discovering={discovering}
          onRefresh={discoverPrinters}
          targetReachable={target?.reachable ?? null}
          onSetDefault={setDefault}
          onRename={renamePrinter}
          onRemove={removePrinter}
          onTest={printTest}
          onAdd={addPrinter}
        />
        {defaultPrinter && (
          <p className="default-note">
            Výchozí tiskárna (systémový i web tisk): <strong>★ {defaultPrinter.name}</strong>
            {badge && <span className={`reach-badge ${badge.cls}`}>{badge.label}</span>}
          </p>
        )}
        {testMsg && <p className="test-msg">{testMsg}</p>}

        <form onSubmit={handleSubmit}>
          <label className="paper-size">
            Šířka papíru
            <select value={paperWidthDots} onChange={(e) => changePaperWidth(Number(e.target.value))}>
              <option value={576}>80 mm (576 bodů)</option>
              <option value={384}>58 mm (384 bodů)</option>
            </select>
          </label>

          <details className="adjust">
            <summary>Úpravy obrazu</summary>
            <label className="paper-size">
              Dithering
              <select
                value={ditherAlgorithm}
                onChange={(e) => {
                  const v = e.target.value as DitherAlgorithm
                  setDitherAlgorithm(v)
                  postSettings({ ditherAlgorithm: v })
                }}
              >
                {(Object.keys(DITHER_LABELS) as DitherAlgorithm[]).map((a) => (
                  <option key={a} value={a}>
                    {DITHER_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
            <label className="slider">
              <span>
                Jas <em>{brightness > 0 ? `+${brightness}` : brightness}</em>
              </span>
              <input type="range" min={-100} max={100} value={brightness} onChange={(e) => { const v = Number(e.target.value); setBrightness(v); postSettings({ brightness: v }) }} />
            </label>
            <label className="slider">
              <span>
                Kontrast <em>{contrast > 0 ? `+${contrast}` : contrast}</em>
              </span>
              <input type="range" min={-100} max={100} value={contrast} onChange={(e) => { const v = Number(e.target.value); setContrast(v); postSettings({ contrast: v }) }} />
            </label>
          </details>

          <div className="drop-zone" onClick={() => fileInputRef.current?.click()}>
            <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(e) => e.target.files && addFiles(e.target.files)} style={{ display: 'none' }} />
            <p>
              Přetáhněte obrázky kamkoliv, vložte z clipboardu nebo <span className="link">vyberte ze souborů</span>
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
                      <img src={item.preview} alt={item.file.name} style={{ transform: `rotate(${item.rotation}deg)` }} />
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
            <input type="number" value={copies} min={1} max={99} onChange={(e) => setCopies(Number(e.target.value))} />
          </label>

          <button type="submit" disabled={status === 'loading' || items.length === 0 || !IPV4.test(defaultIp)}>
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
                  {j.status === 'ok' && (
                    <button type="button" className="job-reprint" onClick={() => reprintJob(j.id)} title="Vytisknout znovu" aria-label="Vytisknout znovu">
                      ↻
                    </button>
                  )}
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
  return source === 'ipp' ? 'Systém' : source === 'web' ? 'Web' : source === 'reprint' ? 'Přetisk' : 'Test'
}

function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })
}
