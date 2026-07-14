import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import AppShell from '@/components/AppShell'
import LoginPage from '@/features/auth/LoginPage'
import HomePage from '@/features/home/HomePage'
import ConnectionsPage from '@/features/admin/ConnectionsPage'
import DatasetsPage from '@/features/datasets/DatasetsPage'
import DatasetDetailPage from '@/features/datasets/DatasetDetailPage'
import ExplorerPage from '@/features/explorer/ExplorerPage'
import MetricsPage from '@/features/metrics/MetricsPage'
import DashboardsPage from '@/features/dashboards/DashboardsPage'
import DashboardPage from '@/features/dashboards/DashboardPage'
import PlaceholderPage from '@/components/PlaceholderPage'
import '@/styles/index.css'

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'datasets', element: <DatasetsPage /> },
      { path: 'datasets/:slug', element: <DatasetDetailPage /> },
      { path: 'datasets/:slug/explore', element: <ExplorerPage /> },
      { path: 'dashboards', element: <DashboardsPage /> },
      { path: 'dashboards/:id', element: <DashboardPage /> },
      { path: 'metrics', element: <MetricsPage /> },
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
