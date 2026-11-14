import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AuthProvider } from './contexts/AuthContext'

const App = lazy(() => import('./App.jsx'))

function Root() {
  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <Suspense fallback={<div className="min-h-screen bg-paper flex items-center justify-center text-muted text-sm lowercase">loading…</div>}>
        <Root />
      </Suspense>
    </AuthProvider>
  </StrictMode>,
)
