import { useState, useRef } from 'react'
import './App.css'

const BACKEND_URL = 'http://localhost:3000'

export default function App() {
  const [ip, setIp] = useState('')
  const [copies, setCopies] = useState(1)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    setImageFile(file)
    if (file) {
      setPreview(URL.createObjectURL(file))
    } else {
      setPreview(null)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!ip || !imageFile) return

    setStatus('loading')
    setErrorMsg('')

    const formData = new FormData()
    formData.append('ip', ip)
    formData.append('image', imageFile)
    formData.append('copies', String(copies))

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
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.1.100"
            required
            pattern="^(\d{1,3}\.){3}\d{1,3}$"
            title="Zadejte platnou IPv4 adresu"
          />
        </label>

        <label>
          Obrázek
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            onChange={handleImageChange}
            required
          />
        </label>

        {preview && (
          <div className="preview">
            <img src={preview} alt="Náhled" />
          </div>
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

        <button type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? 'Odesílám...' : 'Tisknout'}
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
