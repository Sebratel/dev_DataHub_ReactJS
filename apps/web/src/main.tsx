import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import AppShell from '@/components/AppShell'
import LoginPage from '@/features/auth/LoginPage'
import HomePage from '@/features/home/HomePage'
import ConnectionsPage from '@/features/admin/ConnectionsPage'
import AccessPage from '@/features/admin/AccessPage'
import AuditPage from '@/features/admin/AuditPage'
import DatasetsPage from '@/features/datasets/DatasetsPage'
import DatasetDetailPage from '@/features/datasets/DatasetDetailPage'
import DerivedDatasetPage from '@/features/datasets/DerivedDatasetPage'
import ExplorerPage from '@/features/explorer/ExplorerPage'
import MetricsPage from '@/features/metrics/MetricsPage'
import DashboardsPage from '@/features/dashboards/DashboardsPage'
import DashboardPage from '@/features/dashboards/DashboardPage'
import AiPage from '@/features/ai/AiPage'
import IntegrationsPage from '@/features/integrations/IntegrationsPage'
import '@/styles/index.css'

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'datasets', element: <DatasetsPage /> },
      { path: 'datasets/derived/new', element: <DerivedDatasetPage /> },
      { path: 'datasets/:slug', element: <DatasetDetailPage /> },
      { path: 'datasets/:slug/explore', element: <ExplorerPage /> },
      { path: 'dashboards', element: <DashboardsPage /> },
      { path: 'dashboards/:id', element: <DashboardPage /> },
      { path: 'metrics', element: <MetricsPage /> },
      { path: 'ai', element: <AiPage /> },
      { path: 'integrations', element: <IntegrationsPage /> },
      { path: 'admin/connections', element: <ConnectionsPage /> },
      { path: 'admin/access', element: <AccessPage /> },
      { path: 'admin/audit', element: <AuditPage /> },
    ],
  },
])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
)
