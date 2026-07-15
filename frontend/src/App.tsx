import { useState, useRef, useEffect } from 'react'
import { useMirrorLoading } from 'shared-loading-indicator'
import Printers, { type DiscoveredPrinter, type NetworkPrinter } from './Printers'
import { lang, t, translateBackendError } from './i18n'
import './App.css'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

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

const DITHER_LABELS: Record<DitherAlgorithm, string> = t.ditherLabels

interface TargetStatus {
  reachable: boolean
  online: boolean
  paperOut: boolean
  coverOpen: boolean
}

function targetBadge(status: TargetStatus | null): { cls: 'online' | 'offline'; label: string } | null {
  if (!status) return null
  if (!status.reachable) return { cls: 'offline', label: t.statusOffline }
  if (status.paperOut) return { cls: 'offline', label: t.statusPaperOut }
  if (status.coverOpen) return { cls: 'offline', label: t.statusCoverOpen }
  if (!status.online) return { cls: 'offline', label: t.statusNotReady }
  return { cls: 'online', label: t.statusOnline }
}

interface JobLogEntry {
  id: number
  at: number
  source: 'ipp' | 'web' | 'test' | 'reprint'
  printerIp: string
  name: string
  pages?: number
  copies?: number
  format?: 'image' | 'pdf' | 'raster' | 'text'
  status: 'ok' | 'error'
  error?: string
  reprintable?: boolean
  hasPreview?: boolean
}

const FORMAT_LABELS: Record<NonNullable<JobLogEntry['format']>, string> = t.formatLabels

type CutMode = 'full' | 'partial' | 'none'

const CUT_LABELS: Record<CutMode, string> = t.cutLabels

interface QueueJob {
  id: number
  ip: string
  name: string
  source: JobLogEntry['source']
  state: 'queued' | 'printing' | 'waiting'
  copies?: number
  format?: JobLogEntry['format']
  hasPreview?: boolean
}

const QUEUE_STATE_LABELS: Record<QueueJob['state'], string> = t.queueStateLabels

function jobMeta(j: JobLogEntry): string {
  const parts = [j.printerIp || '—']
  if (j.format) parts.push(FORMAT_LABELS[j.format])
  if (j.copies && j.copies > 1) parts.push(`${j.copies}×`)
  if (j.pages && j.pages > 1) parts.push(t.pagesShort(j.pages))
  if (j.status === 'error' && j.error) parts.push(translateBackendError(j.error))
  return parts.join(' · ')
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
  const [cutMode, setCutMode] = useState<CutMode>('full')
  const [jobs, setJobs] = useState<JobLogEntry[]>([])
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  // Close the preview lightbox on Escape.
  useEffect(() => {
    if (previewSrc === null) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPreviewSrc(null)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previewSrc])
  const [queue, setQueue] = useState<QueueJob[]>([])
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

  function refreshQueue() {
    fetch(`${BACKEND_URL}/queue`)
      .then((r) => (r.ok ? r.json() : { queue: [] }))
      .then((d) => setQueue(Array.isArray(d.queue) ? d.queue : []))
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
  }, [])

  // Poll the live print queue so users see jobs waiting / printing.
  useEffect(() => {
    refreshQueue()
    const id = setInterval(refreshQueue, 2000)
    return () => clearInterval(id)
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
        if (cfg.cutMode === 'full' || cfg.cutMode === 'partial' || cfg.cutMode === 'none') setCutMode(cfg.cutMode)
      })
      .catch(() => {})
    loadPrinters()
    refreshJobs()
  }, [])

  // Web Share Target: images shared from the phone land in a cache the SW filled.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('share-target') !== '1') return
    window.history.replaceState(null, '', window.location.pathname)
    ;(async () => {
      try {
        const cache = await caches.open('thermal-print-shared')
        const keys = await cache.keys()
        const shared: File[] = []
        for (const key of keys) {
          const res = await cache.match(key)
          if (!res) continue
          const blob = await res.blob()
          const name = decodeURIComponent(res.headers.get('X-Filename') ?? t.sharedFilename)
          shared.push(new File([blob], name, { type: blob.type }))
          await cache.delete(key)
        }
        if (shared.length) addFiles(shared)
      } catch {
        /* no shared images available */
      }
    })()
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
  function addPrinter(name: string, ip: string, port: number) {
    fetch(`${BACKEND_URL}/printers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip, port }),
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
      .then(() => {
        refreshQueue()
        setTimeout(refreshJobs, 300)
      })
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

  function changeCutMode(mode: CutMode) {
    setCutMode(mode)
    fetch(`${BACKEND_URL}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cutMode: mode }),
    }).catch(() => {})
  }

  // Kick the cash drawer wired to the default printer.
  function openDrawer() {
    if (!IPV4.test(defaultIp)) return
    setTesting(true)
    setTestMsg(t.openingDrawer)
    fetch(`${BACKEND_URL}/drawer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: defaultIp, port: defaultPrinter?.port ?? 9100 }),
    })
      .then((r) => r.json().catch(() => ({})))
      .then((d) => setTestMsg(d?.ok ? t.drawerOpened : t.drawerFailed(translateBackendError(d?.error ?? t.genericError))))
      .catch(() => setTestMsg(t.drawerFailedPlain))
      .finally(() => setTesting(false))
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
  async function printTest(ip: string, name: string, port: number) {
    setTesting(true)
    setTestMsg(t.sendingTest(ip))
    try {
      const res = await fetch(`${BACKEND_URL}/print-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, name, port, lang }),
      })
      const d = await res.json().catch(() => ({}))
      setTestMsg(res.ok && d.ok ? t.testSent(ip) : t.testFailed(ip, translateBackendError(d.error ?? t.genericError)))
    } catch {
      setTestMsg(t.testSendError(ip))
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
    if (defaultPrinter?.port) formData.append('port', String(defaultPrinter.port))
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
      setErrorMsg(translateBackendError(err instanceof Error ? err.message : t.genericError))
      refreshJobs()
    }
  }

  const badge = targetBadge(target)

  return (
    <>
      {pageDragging && (
        <div className="drag-overlay" onDragOver={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()}>
          <p>{t.dropOverlay}</p>
        </div>
      )}
      <main>
        <h1>{t.appTitle}</h1>

        <form onSubmit={handleSubmit} className="print-form card">
          <h2 className="print-heading">{t.printImagesHeading}</h2>
          <div className="drop-zone" onClick={() => fileInputRef.current?.click()}>
            <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={(e) => e.target.files && addFiles(e.target.files)} style={{ display: 'none' }} />
            <p>
              {t.dropHint}
              <span className="link">{t.dropHintAction}</span>
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
                      <button type="button" className="action-btn" onClick={() => rotateImage(i)} title={t.rotate}>
                        ↻
                      </button>
                      <button type="button" className="action-btn remove" onClick={() => removeImage(i)} title={t.remove}>
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
                {t.removeAll}
              </button>
            </>
          )}

          <div className="copies-row">
            <span className="copies-label">{t.copiesLabel}</span>
            <div className="stepper">
              <button type="button" onClick={() => setCopies((c) => Math.max(1, c - 1))} aria-label={t.fewer} disabled={copies <= 1}>
                −
              </button>
              <input
                type="number"
                value={copies}
                min={1}
                max={99}
                onChange={(e) => setCopies(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
              />
              <button type="button" onClick={() => setCopies((c) => Math.min(99, c + 1))} aria-label={t.more} disabled={copies >= 99}>
                +
              </button>
            </div>
          </div>

          <button type="submit" className="print-btn" disabled={status === 'loading' || items.length === 0 || !IPV4.test(defaultIp)}>
            {status === 'loading'
              ? progress
                ? t.printingProgress(progress.current, progress.total)
                : t.preparing
              : t.printButton(defaultPrinter?.name, items.length)}
          </button>
        </form>

        {status === 'success' && <p className="msg success">{t.sentToPrinter}</p>}
        {status === 'error' && <p className="msg error">{t.errorPrefix}: {errorMsg}</p>}

        <Printers
          printers={printers}
          defaultPrinterId={defaultPrinterId}
          discovered={discovered}
          discovering={discovering}
          onRefresh={discoverPrinters}
          targetReachable={target?.reachable ?? null}
          defaultBadge={badge}
          onSetDefault={setDefault}
          onRename={renamePrinter}
          onRemove={removePrinter}
          onTest={printTest}
          onAdd={addPrinter}
        />
        {testMsg && <p className="test-msg">{testMsg}</p>}

        <details className="settings card">
          <summary>{t.settingsSummary}</summary>
          <label className="field">
            {t.paperWidth}
            <select value={paperWidthDots} onChange={(e) => changePaperWidth(Number(e.target.value))}>
              <option value={576}>{t.paperWidth80}</option>
              <option value={384}>{t.paperWidth58}</option>
            </select>
          </label>
          <label className="field">
            {t.cutAfterPrint}
            <select value={cutMode} onChange={(e) => changeCutMode(e.target.value as CutMode)}>
              {(Object.keys(CUT_LABELS) as CutMode[]).map((m) => (
                <option key={m} value={m}>
                  {CUT_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t.dithering}
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
              {t.brightness} <em>{brightness > 0 ? `+${brightness}` : brightness}</em>
            </span>
            <input type="range" min={-100} max={100} value={brightness} onChange={(e) => { const v = Number(e.target.value); setBrightness(v); postSettings({ brightness: v }) }} />
          </label>
          <label className="slider">
            <span>
              {t.contrast} <em>{contrast > 0 ? `+${contrast}` : contrast}</em>
            </span>
            <input type="range" min={-100} max={100} value={contrast} onChange={(e) => { const v = Number(e.target.value); setContrast(v); postSettings({ contrast: v }) }} />
          </label>
          <button type="button" className="drawer-btn" onClick={openDrawer} disabled={testing || !IPV4.test(defaultIp)}>
            {t.openDrawerButton}
          </button>
        </details>

        {queue.length > 0 && (
          <section className="queue card">
            <div className="jobs-head">
              <h2>{t.queueHeading} ({queue.length})</h2>
            </div>
            <ul className="jobs-list">
              {queue.map((q) => (
                <li key={q.id} className={`queue-item state-${q.state}`}>
                  <span className={`queue-spinner ${q.state}`} aria-hidden />
                  {q.hasPreview && (
                    <button
                      type="button"
                      className="job-thumb"
                      onClick={() => setPreviewSrc(`${BACKEND_URL}/queue/${q.id}/preview`)}
                      title={t.showPrintPreview}
                      aria-label={t.showPrintPreview}
                    >
                      <img src={`${BACKEND_URL}/queue/${q.id}/preview?thumb`} alt="" loading="lazy" />
                    </button>
                  )}
                  <span className="job-main">
                    <span className="job-name">
                      <span className="job-source">{jobSourceLabel(q.source)}</span> {q.name}
                    </span>
                    <span className="job-meta">
                      {[q.ip || '—', q.format ? FORMAT_LABELS[q.format] : null, q.copies && q.copies > 1 ? `${q.copies}×` : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className={`queue-state ${q.state}`}>{QUEUE_STATE_LABELS[q.state]}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {jobs.length > 0 && (
          <section className="jobs card">
            <div className="jobs-head">
              <h2>{t.recentJobs}</h2>
              <button type="button" className="jobs-refresh" onClick={refreshJobs} title={t.refresh}>
                ↻
              </button>
            </div>
            <ul className="jobs-list">
              {jobs.slice(0, 10).map((j) => (
                <li key={j.id} className={j.status === 'error' ? 'job-error' : 'job-ok'}>
                  <span className="job-status" aria-hidden>
                    {j.status === 'ok' ? '✓' : '✕'}
                  </span>
                  {j.hasPreview && (
                    <button
                      type="button"
                      className="job-thumb"
                      onClick={() => setPreviewSrc(`${BACKEND_URL}/jobs/${j.id}/preview`)}
                      title={t.showPrintPreview}
                      aria-label={t.showPrintPreview}
                    >
                      <img src={`${BACKEND_URL}/jobs/${j.id}/preview?thumb`} alt="" loading="lazy" />
                    </button>
                  )}
                  <span className="job-main">
                    <span className="job-name">
                      <span className="job-source">{jobSourceLabel(j.source)}</span> {j.name}
                    </span>
                    <span className="job-meta">{jobMeta(j)}</span>
                  </span>
                  <span className="job-time">{relativeTime(j.at)}</span>
                  {j.reprintable && (
                    <button
                      type="button"
                      className="job-reprint"
                      onClick={() => reprintJob(j.id)}
                      title={j.status === 'ok' ? t.printAgain : t.retry}
                      aria-label={j.status === 'ok' ? t.printAgain : t.retry}
                    >
                      ↻
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {previewSrc !== null && (
          <div className="preview-overlay" role="dialog" aria-modal="true" onClick={() => setPreviewSrc(null)}>
            <img className="preview-full" src={previewSrc} alt={t.printPreviewAlt} onClick={(e) => e.stopPropagation()} />
            <div className="preview-toolbar" onClick={(e) => e.stopPropagation()}>
              <a
                className="preview-download"
                href={`${previewSrc}?download`}
                download
                title={t.downloadPreviewTitle}
                aria-label={t.downloadPreview}
              >
                ↓
              </a>
              <button type="button" className="preview-close" onClick={() => setPreviewSrc(null)} aria-label={t.close}>
                ✕
              </button>
            </div>
          </div>
        )}
      </main>
    </>
  )
}

function jobSourceLabel(source: JobLogEntry['source']): string {
  return t.jobSourceLabels[source]
}

function relativeTime(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000)
  if (s < 45) return t.justNow
  const m = Math.floor(s / 60)
  if (m < 1) return t.momentAgo
  if (m < 60) return t.minutesAgo(m)
  return new Date(at).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })
}
