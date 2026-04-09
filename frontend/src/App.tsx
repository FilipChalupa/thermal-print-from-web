import { useState, useRef, useEffect, useCallback } from 'react'
import './App.css'

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? ''

export default function App() {
  const [ip, setIp] = useState('')
  const [copies, setCopies] = useState(1)
  const [images, setImages] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function addFiles(files: FileList | File[]) {
    const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    setImages((prev) => {
      const next = [...prev, ...imageFiles]
      setPreviews(next.map((f) => URL.createObjectURL(f)))
      return next
    })
  }

  function removeImage(index: number) {
    setImages((prev) => {
      const next = prev.filter((_, i) => i !== index)
      setPreviews(next.map((f) => URL.createObjectURL(f)))
      return next
    })
  }

  // Clipboard paste
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (e.clipboardData?.files.length) {
        addFiles(e.clipboardData.files)
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [])

  // Drag & drop
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(true)
  }, [])

  const onDragLeave = useCallback(() => setDragging(false), [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ip || images.length === 0) return

    setStatus('loading')
    setErrorMsg('')

    const formData = new FormData()
    formData.append('ip', ip)
    formData.append('copies', String(copies))
    for (const image of images) {
      formData.append('images', image)
    }

    try {
      const res = await fetch(`${BACKEND_URL}/print`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Print failed')
      }
      setStatus('success')
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Unknown error')
    }
  }

  return (
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

        <div
          className={`drop-zone ${dragging ? 'dragging' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => e.target.files && addFiles(e.target.files)}
            style={{ display: 'none' }}
          />
          <p>Přetáhněte obrázky, vložte z clipboardu nebo <span className="link">vyberte ze souborů</span></p>
        </div>

        {previews.length > 0 && (
          <ul className="preview-grid">
            {previews.map((src, i) => (
              <li key={src}>
                <img src={src} alt={`Obrázek ${i + 1}`} />
                <button
                  type="button"
                  className="remove-btn"
                  onClick={() => removeImage(i)}
                  aria-label="Odebrat"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
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

        <button type="submit" disabled={status === 'loading' || images.length === 0}>
          {status === 'loading' ? 'Odesílám...' : `Tisknout${images.length > 1 ? ` (${images.length} fotek)` : ''}`}
        </button>
      </form>

      {status === 'success' && (
        <p className="msg success">Odesláno do tiskárny!</p>
      )}
      {status === 'error' && (
        <p className="msg error">Chyba: {errorMsg}</p>
      )}
    </main>
  )
}
