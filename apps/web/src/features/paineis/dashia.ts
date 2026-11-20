// Os painéis da empresa vivem no dashia (Indicadores Sebratel). O menu
// "Painéis" do Data Hub mostra o dashia embutido (pedido de 19/11/2026).
//
// O dashia só aceita ser embutido pelo próprio site e por
// https://data-hub.sebratel.net.br (frame-ancestors no nginx dele, versão
// 1.0.4). Trocar de endereço aqui exige liberar o novo lá também.
//
// VITE_DASHIA_URL é opcional e só existe para teste: sem ela, vale o de produção
// (a stack não precisa de variável nova).
export const DASHIA_URL =
  (import.meta.env.VITE_DASHIA_URL as string | undefined)?.trim() || 'https://dashia.sebratel.net.br'
