import React from 'react'
import ReactDOM from 'react-dom/client'
import { createBrowserRouter, RouterProvider, Navigate, type RouteObject } from 'react-router-dom'
import AppShell from '@/components/AppShell'
import { DialogProvider } from '@/components/Dialogs'
import LoginPage from '@/features/auth/LoginPage'
import HomePage from '@/features/home/HomePage'
import ConnectionsPage from '@/features/admin/ConnectionsPage'
import AccessPage from '@/features/admin/AccessPage'
import AuditPage from '@/features/admin/AuditPage'
import HealthModule from '@/features/admin/HealthModule'
import AiProvidersPage from '@/features/admin/AiProvidersPage'
import UpdateRulesModule from '@/features/admin/UpdateRulesModule'
import GatewayApisPage from '@/features/gateway-apis/GatewayApisPage'
import NotebooksPage from '@/features/notebooks/NotebooksPage'
import NotebookPage from '@/features/notebooks/NotebookPage'
import ModelsPage from '@/features/ml/ModelsPage'
import ModelDetailPage from '@/features/ml/ModelDetailPage'
import DatasetsPage from '@/features/datasets/DatasetsPage'
import DatasetDetailPage from '@/features/datasets/DatasetDetailPage'
import DerivedDatasetPage from '@/features/datasets/DerivedDatasetPage'
import TrashPage from '@/features/datasets/TrashPage'
import NamingPage from '@/features/datasets/NamingPage'
import PacksPage from '@/features/datasets/PacksPage'
import ExplorerPage from '@/features/explorer/ExplorerPage'
import MetricsPage from '@/features/metrics/MetricsPage'
import DashboardsPage from '@/features/dashboards/DashboardsPage'
import DashboardPage from '@/features/dashboards/DashboardPage'
import DashiaPage from '@/features/paineis/DashiaPage'
import SuggestionsPage from '@/features/suggestions/SuggestionsPage'
import AiPage from '@/features/ai/AiPage'
import { enterFromHub } from '@/store/authProvider'
import '@/styles/index.css'

const routes: RouteObject[] = [
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
      // Fora de /datasets/: lá, "lixeira" seria lido como o slug de um conjunto.
      { path: 'lixeira', element: <TrashPage /> },
      { path: 'padronizar-nomes', element: <NamingPage /> },
      { path: 'pacotes', element: <PacksPage /> },
      // Menu "Painéis" = dashia embutido. Os painéis do próprio Hub seguem em
      // /dashboards, fora do menu, para quem tem o link.
      { path: 'paineis', element: <DashiaPage /> },
      { path: 'dashboards', element: <DashboardsPage /> },
      { path: 'dashboards/:id', element: <DashboardPage /> },
      { path: 'metrics', element: <MetricsPage /> },
      // Sugestões de melhoria: o mesmo banco do Hub Apps (item 2 de 19/11).
      { path: 'sugestoes', element: <SuggestionsPage /> },
      { path: 'ai', element: <AiPage /> },
      { path: 'gateway-apis', element: <GatewayApisPage /> },
      // Integrações, APIs e Gateway viraram abas do Gateway de APIs; os
      // endereços velhos levam à aba equivalente.
      { path: 'integrations', element: <Navigate to="/gateway-apis#tokens" replace /> },
      { path: 'apis', element: <Navigate to="/gateway-apis#apis" replace /> },
      { path: 'gateway', element: <Navigate to="/gateway-apis" replace /> },
      { path: 'notebooks', element: <NotebooksPage /> },
      { path: 'notebooks/:slug', element: <NotebookPage /> },
      { path: 'models', element: <ModelsPage /> },
      { path: 'models/:slug', element: <ModelDetailPage /> },
      { path: 'admin/connections', element: <ConnectionsPage /> },
      { path: 'admin/access', element: <AccessPage /> },
      { path: 'admin/audit', element: <AuditPage /> },
      // Saúde da plataforma e Qualidade dos dados viraram um módulo com abas (26/11/2026).
      { path: 'admin/health', element: <HealthModule /> },
      // A antiga tela Monitoramento virou um cartão da Saúde da plataforma;
      // o endereço velho continua funcionando para quem o salvou.
      { path: 'admin/monitor', element: <Navigate to="/admin/health" replace /> },
      { path: 'admin/ai-providers', element: <AiProvidersPage /> },
      // Regras de atualização e Padronizar atualização viraram um módulo com abas (26/11/2026).
      { path: 'admin/sync-rules', element: <UpdateRulesModule /> },
      { path: 'admin/quality', element: <Navigate to={{ pathname: '/admin/health', hash: '#qualidade' }} replace /> },
      // Agendamentos virou a faixa de cartões do topo das Regras de atualização.
      { path: 'admin/schedules', element: <Navigate to="/admin/sync-rules" replace /> },
      { path: 'admin/autotune', element: <Navigate to={{ pathname: '/admin/sync-rules', hash: '#padronizar' }} replace /> },
    ],
  },
]

// Aberto pelo Hub Apps (?sso_token): entra ANTES de montar, para o AppShell já
// encontrar o usuário. Sem o parâmetro, não espera nada. O roteador nasce
// DEPOIS, para já ler a URL sem o token.
void enterFromHub().finally(() => {
  const router = createBrowserRouter(routes)
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <DialogProvider>
        <RouterProvider router={router} />
      </DialogProvider>
    </React.StrictMode>,
  )
})
