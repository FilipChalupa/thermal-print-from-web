import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SharedLoadingIndicatorContextProvider, SharedProgressLoadingIndicator } from 'shared-loading-indicator'
import './index.css'
import App from './App.tsx'
import { lang, t } from './i18n'

document.documentElement.lang = lang
document.title = t.appTitle

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SharedLoadingIndicatorContextProvider>
      <SharedProgressLoadingIndicator />
      <App />
    </SharedLoadingIndicatorContextProvider>
  </StrictMode>,
)
