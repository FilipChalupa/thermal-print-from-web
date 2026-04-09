import { useState, useRef, useEffect } from 'react'
import { useStorageBackedState } from 'use-storage-backed-state'
import './App.css'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

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
  const [pageDragging, setPageDragging] = useState(false)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragCounter = useRef(0)
  const isReordering = useRef(false)
  const reorderDragIndex = useRef<number | null>(null)

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
    if (!ip || items.length === 0) return

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
    } catch (err) {
      setStatus('error')
      setProgress(null)
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
    }
  }

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
            <input
              type="text"
              name="printer-ip"
              autoComplete="on"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.100"
              required
              pattern="^(\d{1,3}\.){3}\d{1,3}$"
              title="Zadejte platnou IPv4 adresu"
            />
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

          <button type="submit" disabled={status === 'loading' || items.length === 0}>
            {status === 'loading'
              ? progress
                ? `Tisknu ${progress.current}/${progress.total}…`
                : 'Připravuji…'
              : `Tisknout${items.length > 1 ? ` (${items.length} fotek)` : ''}`}
          </button>
        </form>

        {status === 'success' && <p className="msg success">Odesláno do tiskárny!</p>}
        {status === 'error' && <p className="msg error">Chyba: {errorMsg}</p>}
      </main>
    </>
  )
}
