import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SharedLoadingIndicatorContextProvider, SharedProgressLoadingIndicator } from 'shared-loading-indicator'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SharedLoadingIndicatorContextProvider>
      <SharedProgressLoadingIndicator />
      <App />
    </SharedLoadingIndicatorContextProvider>
  </StrictMode>,
)
