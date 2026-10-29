import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { DemoApplication } from './auth/DemoApplication'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DemoApplication />
  </StrictMode>,
)
