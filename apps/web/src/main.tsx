import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import AppShell from '@/components/AppShell'
import LoginPage from '@/features/auth/LoginPage'
import HomePage from '@/features/home/HomePage'
import ConnectionsPage from '@/features/admin/ConnectionsPage'
import PlaceholderPage from '@/components/PlaceholderPage'
import '@/styles/index.css'

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'datasets', element: <PlaceholderPage title="Conjuntos de Dados" sprint="Sprint 2" /> },
      { path: 'dashboards', element: <PlaceholderPage title="Dashboards" sprint="Sprint 5" /> },
      { path: 'ai', element: <PlaceholderPage title="Assistente IA" sprint="Sprint 6" /> },
      { path: 'integrations', element: <PlaceholderPage title="Integrações" sprint="Sprint 6" /> },
      { path: 'admin/connections', element: <ConnectionsPage /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
