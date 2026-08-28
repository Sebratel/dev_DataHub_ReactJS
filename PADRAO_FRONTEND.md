# Padrão de Frontend

> **Para a IA que vai aplicar este padrão:** este documento é a **fonte da verdade visual**. Ele foi extraído de um sistema já em produção (Nexus Store / PDV) e descreve exatamente as classes, cores, espaçamentos e estruturas a reproduzir. Copie os blocos de código como base, trocando apenas o conteúdo (textos, ícones, campos) — **não reinvente** paleta, raio de borda, tipografia ou hierarquia de layout.
>
> **Nome da marca a usar:** `Nexus Vital`
> Onde aparecer `Nexus Vital` no documento, é texto literal de interface. Onde aparecer `{MÓDULO}` ou `{ENTIDADE}`, substitua pelo domínio do sistema em questão.

---

## 0. Regras de ouro (leia antes de escrever qualquer linha)

1. **Tailwind CSS puro, utility-first.** Sem CSS Modules, sem styled-components, sem arquivos `.css` por componente. O único CSS global é `app/globals.css`.
2. **Escala de cinza = `zinc`.** Nunca `gray`, nunca `neutral`, nunca `stone`. (`slate` aparece só no fundo do `<main>` — ver §5.)
3. **Cor de marca = `indigo`.** Ação primária é sempre `indigo-600`, hover `indigo-700`. Sem exceções, sem "azul", sem "primary" genérico.
4. **Raio de borda:** `rounded-md` (botões-ícone pequenos), `rounded-lg` (botões, inputs internos, itens de menu), `rounded-xl` (cards, inputs de login, modais), `rounded-2xl`/`rounded-full` (avatares, pills, modais grandes). Nunca `rounded-sm` nem `rounded-none`.
5. **Tipografia densa e pesada.** Títulos `font-bold`/`font-extrabold`/`font-black` com `tracking-tight`. Rótulos e microtextos em `uppercase` + `tracking-widest` + tamanhos `text-[10px]`/`text-[11px]`.
6. **Tudo tem `transition`.** `transition-colors` ou `transition-all` em qualquer elemento interativo. Botões primários têm `active:scale-95` (ou `active:scale-[0.98]`).
7. **Ícones: `lucide-react`, sempre.** Tamanhos padrão: `14` (inline/microações), `16`–`18` (botões e menus), `20` (headers e destaque). Nunca emoji como ícone de UI.
8. **Idioma: pt-BR** em toda a interface. Moeda em `R$` via `toLocaleString('pt-BR', { style:'currency', currency:'BRL' })`.
9. **Nada de dark mode** (o sistema é light-only, com o *chrome* escuro: sidebar `zinc-950`).
10. **Nunca deixe um estado sem tratamento visual:** loading, vazio e erro têm componentes definidos (§11).

### Anti-padrões (não faça)
- ❌ Botão colorido "arco-íris" — a única cor de ação é indigo; vermelho é só destrutivo; verde/âmbar são só status.
- ❌ Sombras fortes em elementos internos. Cards usam `shadow-sm`; só modais/dropdowns usam `shadow-xl`/`shadow-2xl`.
- ❌ Bordas grossas. Sempre `border` (1px) `border-zinc-200`.
- ❌ Texto cinza-claro sobre branco abaixo de `zinc-400`.
- ❌ `alert()` / `confirm()` nativos — use Toast e PopupConfirmação (§10).

---

## 1. Stack

| Camada | Escolha |
|---|---|
| Framework | Next.js (App Router) + React + TypeScript |
| Estilo | Tailwind CSS v4 (`@import "tailwindcss"` + `@theme inline`) |
| Ícones | `lucide-react` |
| Toasts | `react-hot-toast` |
| Gráficos | `recharts` |
| Animação (opcional) | `framer-motion` |
| Primitivos (opcional) | `@radix-ui/react-dialog`, `react-dropdown-menu`, `react-tabs` |
| Fonte | `Inter` via `next/font/google` |

```bash
npm i lucide-react react-hot-toast recharts clsx
```

---

## 2. Tokens de design

### 2.1 Cores

| Papel | Token | Hex | Uso |
|---|---|---|---|
| **Marca / ação primária** | `indigo-600` | `#4f46e5` | Botões primários, item de menu ativo, foco, links de ação |
| Marca hover | `indigo-700` | `#4338ca` | Hover do primário |
| Marca clara | `indigo-50` / `indigo-100` | | Fundo de badge, ícone-container, linha selecionada |
| Marca escura (chrome) | `zinc-950` | `#09090b` | Fundo da sidebar |
| Chrome secundário | `zinc-900` | `#18181b` | Painel visual do login, hover na sidebar, tooltip de gráfico |
| Fundo da aplicação | `slate-100` | `#f1f5f9` | `<main>` |
| Fundo alternativo | `zinc-50` | `#fafafa` | Inputs, headers de modal, footers, hover de lista |
| Superfície | `white` | `#ffffff` | Cards, topbar, modais, tabelas |
| Borda | `zinc-200` | `#e4e4e7` | Padrão de todas as bordas |
| Borda suave | `zinc-100` / `zinc-50` | | Divisórias internas de lista |
| Texto forte | `zinc-900` | `#18181b` | Títulos e valores |
| Texto corpo | `zinc-700` / `zinc-600` | | Parágrafos |
| Texto secundário | `zinc-500` | | Legendas, descrições |
| Texto fraco | `zinc-400` | | Rótulos, placeholders, microtextos |
| **Sucesso** | `emerald-600` / `emerald-50` | | Valores positivos, status OK |
| **Atenção** | `amber-500/600` / `amber-50` | | Estoque baixo, avisos, "inativo" |
| **Erro / destrutivo** | `red-500/600` / `red-50` | | Sair, excluir, crítico |
| Info | `blue-500` / `blue-100` | | Notificações informativas |
| Acento decorativo | `purple-600`, `violet-*` | | Gradientes de avatar, badge "Online" |

**Gradiente de avatar (obrigatório para iniciais de usuário):**
`bg-gradient-to-br from-indigo-500 to-purple-600`

**Cores de gráfico:** série principal `#4f46e5` (indigo-600), série de comparação `#d4d4d8` (zinc-300), grid `#f4f4f5`, eixos `#a1a1aa`.

### 2.2 Tipografia

| Uso | Classes |
|---|---|
| Título de página | `text-lg font-extrabold text-zinc-900 tracking-tight` |
| Título de tela de login | `text-3xl font-black text-zinc-900 tracking-tighter` |
| Título de card/seção | `text-sm font-bold text-zinc-800 uppercase tracking-wide` |
| Título de modal | `text-lg font-bold text-zinc-900` |
| Valor de KPI | `text-2xl font-black text-zinc-900 tracking-tight` |
| Rótulo de campo | `text-[10px] font-black text-zinc-400 uppercase tracking-widest` |
| Rótulo de KPI | `text-[11px] font-bold text-zinc-500 uppercase tracking-widest` |
| Corpo | `text-sm text-zinc-600` |
| Legenda / subtítulo | `text-xs text-zinc-500` |
| Microtexto | `text-[10px]` / `text-[11px] text-zinc-400` |
| Código / SKU / ID | `font-mono text-[10px] text-zinc-400` |
| Texto de botão primário | `text-xs font-bold uppercase tracking-wide` (ou `tracking-[2px]` no login) |

### 2.3 Espaçamento, borda e sombra

- **Padding de card:** `p-5` (padrão) ou `p-4` (compacto).
- **Gap de grid:** `gap-4` (KPIs) / `gap-6` (blocos de gráfico).
- **Padding do `<main>`:** `px-4 md:px-6 pb-6 pt-2`.
- **Espaço vertical entre seções:** `space-y-6`.
- **Header de card/modal:** `px-6 py-4 border-b border-zinc-200`.
- **Sombras:** `shadow-sm` (cards), `shadow-md` (botão ativo/hover), `shadow-xl` (dropdown, botão de login), `shadow-2xl` (modal).
- **Sombra colorida** (usar com parcimônia no primário): `shadow-sm shadow-indigo-200`.

### 2.4 Foco (acessibilidade — obrigatório)

Todo input/select/textarea:
```
focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all
```
No login (variante mais suave): `focus:ring-4 focus:ring-indigo-500/5 focus:border-indigo-500`.

Ícone dentro do input acompanha o foco via `group`:
```tsx
<div className="relative group">
  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-indigo-500 transition-colors" size={14} />
  <input className="w-full bg-zinc-50 border border-zinc-200 rounded-lg pl-9 pr-3 py-1.5 text-sm ..." />
</div>
```

---

## 3. `app/globals.css` (copiar integralmente)

```css
@import "tailwindcss";

:root {
  --background: #f5f7fb;
  --foreground: #0f172a;
  --card: #ffffff;
  --border: #e2e8f0;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-border: var(--border);
  --font-sans: Inter, Arial, Helvetica, sans-serif;
}

body {
  background-color: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
}

/* Esconde scrollbar mantendo o scroll */
.scrollbar-hide::-webkit-scrollbar { display: none; }
.scrollbar-hide { -ms-overflow-style: none; scrollbar-width: none; }

/* Brilho suave para destaque de marca */
.glow-indigo { box-shadow: 0 0 60px -10px rgba(79, 70, 229, 0.5); }

.text-gradient {
  background: linear-gradient(135deg, #818cf8 0%, #a78bfa 50%, #c084fc 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

### `app/layout.tsx`

```tsx
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Nexus Vital",
  description: "{DESCRIÇÃO CURTA DO SISTEMA}",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className="h-full">
      <body className={`${inter.className} h-full`}>{children}</body>
    </html>
  );
}
```

---

## 4. Tela de Login (padrão de referência)

**Estrutura obrigatória:** duas colunas em `lg`, colapsando para uma no mobile.
- **Esquerda (branca):** identidade → botões sociais → divisor "ou com email" → formulário → rodapé.
- **Direita (`zinc-900`, oculta no mobile):** selo "Ambiente Seguro", frase de valor, autoria, mini-cards decorativos com métricas. Fundo com dois *blobs* desfocados (indigo + purple).

```tsx
"use client";

import { useState } from "react";
import { Mail, Lock, Eye, EyeOff, Loader2, ArrowRight, ShieldCheck } from "lucide-react";
import { toast, Toaster } from "react-hot-toast";

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      // TODO: autenticação do sistema
      toast.success("Login realizado com sucesso!");
    } catch {
      toast.error("Email ou senha incorretos");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-white">
      <Toaster position="top-right" />

      {/* COLUNA ESQUERDA: FORMULÁRIO */}
      <div className="flex items-center justify-center p-8 lg:p-16">
        <div className="w-full max-w-[400px] space-y-8">

          {/* Identidade */}
          <div className="flex flex-col gap-2">
            <div className="w-10 h-10 bg-zinc-900 rounded-xl flex items-center justify-center text-white font-black text-xs shadow-xl">
              NV
            </div>
            <h1 className="text-3xl font-black text-zinc-900 tracking-tighter">
              Bem-vindo de volta
            </h1>
            <p className="text-zinc-500 font-medium">
              Acesse sua conta Nexus Vital para continuar.
            </p>
          </div>

          {/* Divisor */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-zinc-100" />
            </div>
            <div className="relative flex justify-center text-[10px] uppercase font-bold tracking-widest">
              <span className="bg-white px-4 text-zinc-400">ou com email</span>
            </div>
          </div>

          {/* Formulário */}
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="space-y-1">
              <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest ml-1">
                E-mail
              </label>
              <div className="relative group">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300 group-focus-within:text-indigo-500 transition-colors" size={18} />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="seu@email.com"
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-500/5 focus:border-indigo-500 transition-all font-medium"
                />
              </div>
            </div>

            <div className="space-y-1">
              <div className="flex justify-between items-center px-1">
                <label className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Senha</label>
                <button type="button" className="text-[10px] font-black text-indigo-600 uppercase hover:underline">
                  Esqueci a senha
                </button>
              </div>
              <div className="relative group">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-300 group-focus-within:text-indigo-500 transition-colors" size={18} />
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-xl pl-10 pr-12 py-3 text-sm focus:outline-none focus:ring-4 focus:ring-indigo-500/5 focus:border-indigo-500 transition-all font-medium"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-300 hover:text-zinc-600 transition-colors"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-zinc-900 hover:bg-zinc-800 text-white py-4 rounded-xl font-black text-xs uppercase tracking-[2px] shadow-xl shadow-zinc-200 transition-all active:scale-[0.98] flex items-center justify-center gap-2 group"
            >
              {isLoading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <>
                  Entrar no Painel
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </>
              )}
            </button>
          </form>

          <p className="text-center text-[11px] text-zinc-400 font-medium">
            Não tem uma conta?{" "}
            <button className="text-zinc-900 font-bold hover:underline">Contate o administrador</button>
          </p>
        </div>
      </div>

      {/* COLUNA DIREITA: VISUAL / MARCA */}
      <div className="hidden lg:flex relative bg-zinc-900 overflow-hidden items-center justify-center p-16">
        <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-indigo-600 rounded-full mix-blend-multiply filter blur-[120px] opacity-20 animate-pulse" />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] bg-purple-600 rounded-full mix-blend-multiply filter blur-[100px] opacity-20 animate-pulse delay-700" />

        <div className="relative z-10 space-y-6 max-w-md">
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-white/5 border border-white/10 rounded-full backdrop-blur-md">
            <ShieldCheck className="text-indigo-400" size={14} />
            <span className="text-[10px] font-black text-white uppercase tracking-widest">Ambiente Seguro</span>
          </div>

          <blockquote className="space-y-4">
            <p className="text-4xl font-black text-white leading-tight tracking-tighter">
              "{FRASE DE VALOR DO SISTEMA — uma linha, direta}"
            </p>
            <footer className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 border-2 border-white/10" />
              <div>
                <p className="text-sm font-bold text-white uppercase tracking-wide">Nexus Vital</p>
                <p className="text-xs text-zinc-500 font-medium">Plataforma de gestão</p>
              </div>
            </footer>
          </blockquote>

          <div className="pt-8 grid grid-cols-2 gap-4">
            <div className="bg-white/5 border border-white/10 p-4 rounded-2xl backdrop-blur-sm">
              <p className="text-[10px] font-bold text-zinc-500 uppercase">{MÉTRICA 1}</p>
              <p className="text-xl font-black text-white">{VALOR 1}</p>
            </div>
            <div className="bg-white/5 border border-white/10 p-4 rounded-2xl backdrop-blur-sm">
              <p className="text-[10px] font-bold text-zinc-500 uppercase">{MÉTRICA 2}</p>
              <p className="text-xl font-black text-white">{VALOR 2}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

**Botão social (quando houver OAuth):**
```tsx
<button className="flex items-center justify-center gap-2 px-4 py-2.5 border border-zinc-200 rounded-xl hover:bg-zinc-50 transition-all font-bold text-[11px] uppercase tracking-wider text-zinc-700 disabled:opacity-60 disabled:cursor-not-allowed">
  {/* svg do provedor em w-4 h-4 */} Google
</button>
```

---

## 5. Shell da aplicação (layout autenticado)

Estrutura: **Sidebar fixa escura** + **Topbar branca sticky** + **`<main>` scrollável**.

```tsx
"use client";
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar();
  return (
    <div className="h-screen overflow-hidden flex">
      <Sidebar />
      <div className={`h-screen flex flex-col flex-1 transition-all duration-300 ${collapsed ? "ml-0 md:ml-16" : "ml-0 md:ml-64"}`}>
        <Topbar />
        <main className="flex-1 overflow-y-auto px-4 md:px-6 pb-6 pt-2 bg-slate-100">
          {children}
        </main>
      </div>
    </div>
  );
}
```

Regras do shell:
- Sidebar: `w-64` expandida / `w-16` colapsada, `transition-all duration-300`.
- No mobile a sidebar vira *drawer*: `-translate-x-full md:translate-x-0` + overlay `fixed inset-0 bg-black/50 z-40 md:hidden`.
- Estado (`collapsed`, `mobileOpen`) vive num **Context** (`SidebarContext`), não em prop drilling.
- Só o `<main>` rola. O container raiz é `h-screen overflow-hidden`.

### 5.1 Sidebar

```tsx
<aside className={`fixed top-0 left-0 h-screen bg-zinc-950 text-zinc-400 border-r border-zinc-800
  flex flex-col z-50 transition-all duration-300
  ${collapsed ? "w-16" : "w-64"}
  ${mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}>

  {/* Header da marca */}
  <div className={`p-4 flex items-center gap-3 text-white min-h-[64px] ${collapsed ? "justify-center" : ""}`}>
    <div className="bg-indigo-600 p-2 rounded-lg shadow-lg shadow-indigo-500/20 shrink-0">
      <Activity size={20} className="text-white" />
    </div>
    {!collapsed && <span className="text-lg font-bold tracking-tight whitespace-nowrap">Nexus Vital</span>}
  </div>

  {/* Navegação */}
  <nav className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
    {!collapsed && (
      <p className="px-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-3">Principal</p>
    )}
    {menuItems.map((item) => {
      const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
      return (
        <Link
          key={item.href}
          href={item.href}
          title={collapsed ? item.name : undefined}
          className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200
            ${collapsed ? "justify-center" : ""}
            ${isActive
              ? "bg-indigo-600 text-white shadow-md shadow-indigo-900/20"
              : "hover:bg-zinc-900 hover:text-white"}`}
        >
          <item.icon size={18} className={isActive ? "text-white" : "text-zinc-400"} />
          {!collapsed && <span className="flex-1">{item.name}</span>}
        </Link>
      );
    })}
  </nav>

  {/* Rodapé: colapsar, configurações, sair, mini-perfil */}
  <div className="p-3 border-t border-zinc-800">
    <button onClick={toggleCollapsed}
      className={`hidden md:flex w-full items-center px-3 py-2 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900 transition-colors mb-2 text-xs ${collapsed ? "justify-center" : "gap-2"}`}>
      {collapsed ? <ChevronsRight size={16} /> : <><ChevronsLeft size={16} /><span>Recolher menu</span></>}
    </button>

    <button onClick={handleLogout}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:bg-red-950/30 hover:text-red-300 transition-colors ${collapsed ? "justify-center" : ""}`}>
      <LogOut size={18} />{!collapsed && "Sair"}
    </button>

    {!collapsed && (
      <div className="mt-3 flex items-center gap-3 px-2 py-2 rounded-lg bg-zinc-900/50">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-xs text-white font-bold shrink-0">
          {user?.initials ?? ".."}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-medium text-white truncate">{user?.name ?? "Carregando..."}</span>
          <span className="text-[10px] text-zinc-500 truncate">{roleLabel}</span>
        </div>
      </div>
    )}
  </div>
</aside>
```

**Item de menu desabilitado (sem permissão):** `opacity-40 cursor-not-allowed`, renderizado como `<div>` (não navegável).
**Badge de contagem no menu:** `text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center` — `bg-red-500 text-white` (crítico) ou `bg-amber-500 text-white` (atenção). Colapsado, vira ponto: `absolute top-1 right-1 w-2 h-2 rounded-full`.

**Iniciais do usuário** (helper padrão):
```ts
const initials = name.split(" ").filter(Boolean).slice(0, 2).map((n) => n[0]).join("").toUpperCase();
```

### 5.2 Topbar

```tsx
<header className="h-14 bg-white/80 backdrop-blur-md border-b border-zinc-200 sticky top-0 z-40 flex items-center justify-between px-4">
  {/* ESQUERDA: hamburger mobile + breadcrumb */}
  <div className="flex items-center gap-3">
    <button onClick={toggleMobile} aria-label="Abrir menu"
      className="p-1.5 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded-md transition-colors md:hidden">
      <Menu size={20} />
    </button>
    <nav className="hidden md:flex items-center gap-2 text-sm text-zinc-500">
      <span className="hover:text-zinc-900 cursor-pointer transition-colors">Nexus Vital</span>
      <Slash size={12} className="text-zinc-300" />
      <span className="font-medium text-zinc-900 bg-zinc-100 px-2 py-0.5 rounded-md">{currentPage}</span>
    </nav>
  </div>

  {/* CENTRO: busca global com atalho */}
  <div className="flex-1 max-w-md mx-4 hidden md:block">
    <div className="relative group">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400 group-focus-within:text-indigo-500 transition-colors" size={14} />
      <input ref={searchRef} type="text" placeholder="Buscar... (/ ou Ctrl+K)"
        className="w-full bg-zinc-50 border border-zinc-200 text-zinc-800 text-sm rounded-lg pl-9 pr-12 py-1.5 outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all placeholder:text-zinc-400" />
      <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
        <kbd className="bg-white border border-zinc-200 rounded px-1.5 py-0.5 text-[10px] font-medium text-zinc-500 flex items-center gap-0.5 shadow-sm">
          <Command size={10} /> K
        </kbd>
      </div>
    </div>
  </div>

  {/* DIREITA: ações-ícone + perfil */}
  <div className="flex items-center gap-2">
    <button className="p-2 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-md transition-colors relative" aria-label="Notificações">
      <Bell size={18} />
      {unreadCount > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center px-0.5 border-2 border-white">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </button>

    <div className="pl-2 border-l border-zinc-200 ml-1 relative">
      <button className="flex items-center gap-2 p-1 hover:bg-zinc-50 rounded-lg transition-colors border border-transparent hover:border-zinc-200 group">
        <div className="w-8 h-8 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-md flex items-center justify-center text-white font-bold text-xs shadow-sm group-hover:shadow-md transition-all">
          {user?.initials ?? ".."}
        </div>
        <div className="text-left hidden lg:block">
          <p className="text-xs font-semibold text-zinc-800 leading-none">{user?.name}</p>
          <p className="text-[10px] text-zinc-500 leading-none mt-1">{roleLabel}</p>
        </div>
        <ChevronDown size={14} className={`text-zinc-400 hidden lg:block transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
    </div>
  </div>
</header>
```

**Atalhos de teclado obrigatórios:** `Ctrl+K` e `/` focam a busca; `?` abre o modal de atalhos; `Esc` fecha dropdowns/painéis. Ignore quando o foco estiver em `INPUT`/`TEXTAREA`/`contentEditable`.
**Dropdowns fecham ao clicar fora** (listener `mousedown` + `ref`).

---

## 6. Header de página

Todo módulo abre com um header branco, ícone indigo, título, subtítulo de contexto e ações à direita.

```tsx
<div className="flex items-center justify-between px-6 py-4 bg-white border-b border-zinc-200 shrink-0">
  <div>
    <div className="flex items-center gap-2">
      <LayoutDashboard size={20} className="text-indigo-600" strokeWidth={2.5} />
      <h1 className="text-lg font-extrabold text-zinc-900 tracking-tight">{TÍTULO DO MÓDULO}</h1>
    </div>
    <p className="text-xs text-zinc-500 mt-0.5">{contexto — ex.: "Última atualização: hoje, 14:32"}</p>
  </div>

  <div className="flex items-center gap-3">
    {/* Seletor segmentado */}
    <div className="flex items-center gap-1 bg-zinc-50 border border-zinc-200 rounded-lg p-1">
      {opcoes.map((o) => (
        <button key={o.valor} onClick={() => setValor(o.valor)}
          className={`px-3 py-1.5 rounded-md text-xs font-bold transition-all disabled:opacity-50 ${
            valor === o.valor ? "bg-indigo-600 text-white shadow-sm" : "text-zinc-500 hover:bg-zinc-100"}`}>
          {o.label}
        </button>
      ))}
    </div>

    <button className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-xs font-bold uppercase tracking-wide shadow-sm shadow-indigo-200 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-2">
      <Download size={14} /> Exportar
    </button>
  </div>
</div>
```

---

## 7. Botões — variantes canônicas

| Variante | Classes |
|---|---|
| **Primária** | `bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-medium shadow-sm transition-all active:scale-95 disabled:opacity-50 flex items-center gap-2` |
| **Primária compacta (header)** | `bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-md text-xs font-bold uppercase tracking-wide shadow-sm shadow-indigo-200 transition-all active:scale-95` |
| **Primária escura (login/CTA)** | `bg-zinc-900 hover:bg-zinc-800 text-white py-4 rounded-xl font-black text-xs uppercase tracking-[2px] shadow-xl shadow-zinc-200 transition-all active:scale-[0.98]` |
| **Secundária / cancelar** | `px-4 py-2 bg-white border border-zinc-300 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50 transition-colors disabled:opacity-50` |
| **Fantasma (ícone)** | `p-2 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 rounded-md transition-colors` |
| **Fantasma indigo (ícone)** | `p-2 text-zinc-500 hover:text-indigo-600 hover:bg-zinc-100 rounded-lg transition-colors` |
| **Ícone primário (criar)** | `p-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm transition-all active:scale-95` |
| **Destrutiva** | `bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors` |
| **Destrutiva fantasma** | `text-red-500 hover:bg-red-50 px-4 py-2 rounded-lg text-xs transition-colors` |
| **Link de ação** | `text-indigo-600 hover:text-indigo-700 text-sm font-medium` |
| **Pill destaque** | `bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-full text-xs font-medium shadow-sm shadow-indigo-200 hover:shadow-md hover:-translate-y-0.5 transition-all` |

**Regras:** todo botão que dispara IO tem estado `disabled` + `<Loader2 className="animate-spin" />`. Botão só de ícone **exige** `title` e/ou `aria-label`.

```tsx
{salvando ? (<><Loader2 size={16} className="animate-spin" /> Processando...</>) : "Salvar"}
```

---

## 8. Cards

### 8.1 Card container (padrão para qualquer bloco)
```tsx
<div className="bg-white p-5 rounded-xl border border-zinc-200 shadow-sm flex flex-col">
  <h3 className="text-sm font-bold text-zinc-800 uppercase tracking-wide mb-1">{TÍTULO}</h3>
  <p className="text-xs text-zinc-500 mb-6">{subtítulo}</p>
  {/* conteúdo */}
</div>
```

### 8.2 Card de KPI
Grid: `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4`.

```tsx
function KpiCard({ title, value, subtext, icon: Icon, trend, trendValue, colorClass, isLoading, onClick }: KpiCardProps) {
  return (
    <div
      onClick={onClick}
      className={`bg-white p-5 rounded-xl border border-zinc-200 shadow-sm flex flex-col justify-between hover:border-indigo-300 transition-colors group${onClick ? " cursor-pointer" : ""}`}
    >
      <div className="flex justify-between items-start mb-2">
        <div className={`p-2 rounded-lg border ${colorClass} group-hover:scale-110 transition-transform`}>
          <Icon size={20} />
        </div>
        {trend && !isLoading && (
          <div className={`flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full ${
            trend === "up" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
            {trend === "up" ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
            <span>{trendValue}%</span>
          </div>
        )}
      </div>
      <div>
        <h3 className="text-zinc-500 text-[11px] font-bold uppercase tracking-widest">{title}</h3>
        {isLoading
          ? <div className="mt-2 h-8 w-3/4 bg-zinc-200 rounded animate-pulse" />
          : <p className="text-2xl font-black text-zinc-900 mt-1 tracking-tight">{value}</p>}
        {!isLoading && subtext && <p className="text-xs text-zinc-400 mt-1">{subtext}</p>}
      </div>
    </div>
  );
}
```

`colorClass` por natureza da métrica (mantenha esta rotação):
- Financeiro / principal → `bg-indigo-100 text-indigo-700`
- Volume / positivo → `bg-emerald-100 text-emerald-700`
- Média / neutro → `bg-amber-100 text-amber-700`
- Risco / alerta → `bg-rose-100 text-rose-700`

---

## 9. Listas, tabelas e status

### 9.1 Barra de filtros (acima da lista)
```tsx
<div className="flex gap-2">
  <div className="relative flex-1">
    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" size={14} />
    <input type="text" placeholder="Buscar {ENTIDADE}..." value={busca} onChange={(e) => setBusca(e.target.value)}
      className="w-full pl-8 pr-3 py-1.5 bg-zinc-50 border border-zinc-200 rounded-md text-xs focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500" />
  </div>
  {/* Toggle de filtro: inativo vs ativo */}
  <button onClick={() => setFiltro(!filtro)} title={filtro ? "Mostrar todos" : "Filtrar críticos"}
    className={`p-1.5 border rounded-md flex items-center gap-1 transition-colors text-xs font-semibold ${
      filtro ? "bg-red-50 border-red-300 text-red-600"
             : "bg-zinc-50 border-zinc-200 text-zinc-500 hover:text-red-600 hover:border-red-200"}`}>
    <AlertCircle size={14} /><span className="text-[11px]">Críticos</span>
  </button>
</div>
```
Use **debounce** na busca (hook `useDebounce`, ~300 ms) antes de consultar o backend.

### 9.2 Item de lista selecionável (padrão master-detail)
```tsx
<div onClick={() => setSelecionado(item)}
  className={`group p-3 border-b border-zinc-50 cursor-pointer hover:bg-zinc-50 transition-all ${
    selecionado?.id === item.id
      ? "bg-indigo-50/60 border-l-2 border-l-indigo-600"
      : "border-l-2 border-l-transparent"
  } ${!item.is_active ? "opacity-60" : ""}`}>
  <div className="flex justify-between items-start mb-1">
    <span className="font-semibold text-zinc-800 truncate">{item.nome}</span>
    <span className={`text-[10px] px-1.5 rounded-full border font-medium ${status.color}`}>{status.label}</span>
  </div>
  <div className="flex justify-between items-center">
    <span className="font-mono text-[10px] text-zinc-400">{item.codigo}</span>
    <div className="font-bold text-sm text-zinc-800">{valor}</div>
  </div>
</div>
```

### 9.3 Badges de status (helper padronizado)
```ts
export function getStatus(qtd: number, min: number) {
  if (qtd <= min)       return { label: "Crítico", color: "text-red-600 bg-red-50 border-red-200",         dot: "bg-red-500" };
  if (qtd <= min * 1.5) return { label: "Baixo",   color: "text-amber-600 bg-amber-50 border-amber-200",   dot: "bg-amber-500" };
  return                       { label: "OK",      color: "text-emerald-600 bg-emerald-50 border-emerald-200", dot: "bg-emerald-500" };
}
```
Badge de papel/permissão: `text-[9px] font-black uppercase tracking-wider px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded-full`.

### 9.4 Paginação
```tsx
<div className="flex items-center justify-between px-3 py-2 border-t border-zinc-100 bg-zinc-50 shrink-0">
  <button disabled={pagina === 1} className="p-1.5 rounded-md border border-zinc-200 text-zinc-500 disabled:opacity-30 hover:bg-zinc-100 transition-colors">
    <ChevronLeft size={14} />
  </button>
  <span className="text-[10px] font-bold text-zinc-500">Página {pagina} de {totalPaginas}</span>
  <button disabled={pagina === totalPaginas} className="p-1.5 rounded-md border border-zinc-200 text-zinc-500 disabled:opacity-30 hover:bg-zinc-100 transition-colors">
    <ChevronRight size={14} />
  </button>
</div>
```

---

## 10. Modais, confirmação e toasts

### 10.1 Modal (formulário / detalhe)
```tsx
<div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
  <div className="bg-white w-full max-w-6xl rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[95vh]">

    <div className="px-6 py-4 border-b border-zinc-200 flex justify-between items-center bg-zinc-50">
      <div className="flex items-center gap-2">
        <div className="bg-indigo-100 p-2 rounded-lg">
          <Package className="text-indigo-600" size={20} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-zinc-900">{mode === "create" ? "Novo {ENTIDADE}" : "Editar {ENTIDADE}"}</h2>
          <p className="text-xs text-zinc-500">{descrição curta da ação}</p>
        </div>
      </div>
      <button onClick={onClose} aria-label="Fechar"
        className="p-2 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 rounded-full transition-colors">
        <X size={20} />
      </button>
    </div>

    <div className="flex-1 overflow-y-auto p-6">{/* formulário */}</div>

    <div className="flex justify-end gap-3 p-4 bg-zinc-50 border-t border-zinc-200">
      <button onClick={onClose} className="px-4 py-2 bg-white border border-zinc-300 text-zinc-700 rounded-lg text-sm font-medium hover:bg-zinc-50 transition-colors">Cancelar</button>
      <button className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2">Salvar</button>
    </div>
  </div>
</div>
```
**Camadas de `z-index`:** overlay de sidebar mobile `z-40` · topbar `z-40` · sidebar `z-50` · modal `z-50` · confirmação sobre modal `z-[60]`.
**`Esc` fecha o modal.** Clique no overlay fecha; clique no conteúdo usa `e.stopPropagation()`.

### 10.2 Popup de confirmação (substitui `confirm()`)
Tipos: `sucesso | erro | aviso | info`, cada um com ícone, borda e cor de botão próprios.

```tsx
const icones = {
  sucesso: <CheckCircle className="text-emerald-500" size={32} />,
  erro:    <AlertTriangle className="text-red-500" size={32} />,
  aviso:   <AlertTriangle className="text-amber-500" size={32} />,
  info:    <Info className="text-blue-500" size={32} />,
};
const cores = {
  sucesso: "bg-emerald-50 border-emerald-200",
  erro:    "bg-red-50 border-red-200",
  aviso:   "bg-amber-50 border-amber-200",
  info:    "bg-blue-50 border-blue-200",
};
const coresBotao = {
  sucesso: "bg-emerald-600 hover:bg-emerald-700",
  erro:    "bg-red-600 hover:bg-red-700",
  aviso:   "bg-amber-600 hover:bg-amber-700",
  info:    "bg-blue-600 hover:bg-blue-700",
};
```
Shell: `fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4` → `bg-white rounded-xl shadow-2xl max-w-md w-full border ${cores[tipo]} overflow-hidden`. Popup de `sucesso` pode auto-fechar (`tempoAutoFechar` em ms).

### 10.3 Toasts
`react-hot-toast` com `<Toaster position="top-right" />`. Mensagens curtas, em pt-BR, sempre afirmativas:
```ts
toast.success("Login realizado com sucesso!");
toast.error("Email ou senha incorretos");
toast.error("Acesso negado. Você não tem permissão para acessar o sistema.");
```

---

## 11. Estados: loading, vazio e erro

**Skeleton** (preferido a spinner em áreas de conteúdo):
```tsx
<div className="mt-2 h-8 w-3/4 bg-zinc-200 rounded animate-pulse" />
<div className="h-full w-full bg-zinc-200 rounded animate-pulse" />   {/* gráfico */}
```

**Vazio** — ícone grande cinza + texto + ação de saída:
```tsx
<div className="p-8 text-center">
  <Package className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
  <p className="text-zinc-500 text-sm mb-4">{busca ? "Nenhum resultado encontrado" : "Nenhum {ENTIDADE} cadastrado"}</p>
  {!busca && (
    <button onClick={criarNovo} className="text-indigo-600 hover:text-indigo-700 font-medium text-sm">
      Cadastre o primeiro
    </button>
  )}
</div>
```

**Erro** — ícone vermelho + mensagem + "Tentar novamente":
```tsx
<div className="p-4 text-center">
  <AlertCircle className="h-8 w-8 text-red-500 mx-auto mb-2" />
  <p className="text-red-600 text-sm">{erro}</p>
  <button onClick={recarregar} className="mt-2 text-indigo-600 hover:text-indigo-700 text-sm font-medium">
    Tentar novamente
  </button>
</div>
```

---

## 12. Gráficos (recharts)

Configuração fixa para manter identidade:

```tsx
<ResponsiveContainer width="100%" height="100%">
  <AreaChart data={dados} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
    <defs>
      <linearGradient id="colorPrincipal" x1="0" y1="0" x2="0" y2="1">
        <stop offset="5%"  stopColor="#4f46e5" stopOpacity={0.15} />
        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
      </linearGradient>
    </defs>
    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#f4f4f5" />
    <XAxis dataKey="dia" axisLine={false} tickLine={false} tick={{ fill: "#a1a1aa", fontSize: 11 }} dy={10} />
    <YAxis axisLine={false} tickLine={false} tick={{ fill: "#a1a1aa", fontSize: 11 }}
           tickFormatter={(v) => `R$${Number(v) / 1000}k`} />
    <Tooltip
      contentStyle={{ backgroundColor: "#18181b", borderRadius: "8px", border: "none", color: "#fff", fontSize: "12px" }}
      itemStyle={{ color: "#e4e4e7" }}
      formatter={(v) => formatCurrency(v as number)} />
    <Area type="monotone" dataKey="principal"  stroke="#4f46e5" strokeWidth={3} fill="url(#colorPrincipal)" />
    <Area type="monotone" dataKey="comparacao" stroke="#d4d4d8" strokeWidth={2} fill="transparent" />
  </AreaChart>
</ResponsiveContainer>
```

Regras:
- Sem grid vertical; grid horizontal `strokeDasharray="3 3"` em `#f4f4f5`.
- Eixos sem linha nem tick (`axisLine={false} tickLine={false}`).
- Altura fixa no container: `h-[280px]` (principal) / `h-[200px]` (secundário).
- Donut: `innerRadius={60} outerRadius={80} paddingAngle={5}`, com total sobreposto no centro (`absolute inset-0 ... pointer-events-none`).
- Legenda manual em vez de `<Legend>`: `<span className="w-2 h-2 rounded-full bg-indigo-600" /> Rótulo`.

---

## 13. Responsividade

- **Breakpoints usados:** `sm` (ações secundárias da topbar), `md` (sidebar fixa vs drawer, busca, grids 2 colunas), `lg` (grids 3–4 colunas, painel visual do login, nome do usuário na topbar).
- Grid de KPIs: `grid-cols-1 md:grid-cols-2 lg:grid-cols-4`.
- Grid de gráficos: `grid-cols-1 lg:grid-cols-3` com o principal em `lg:col-span-2`.
- Ações não essenciais escondem no mobile: `hidden sm:flex` / `hidden md:block`.
- Sempre `truncate` + `min-w-0` em texto dentro de flex; `shrink-0` em ícones e avatares.

---

## 14. Formatação e microcopy (pt-BR)

```ts
const formatCurrency = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const formatDate     = (d: string) => new Date(d).toLocaleDateString("pt-BR");
const formatTime     = (d: Date)   => d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

function timeAgo(dateStr: string) {
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 60)    return "agora";
  if (diff < 3600)  return `${Math.floor(diff / 60)}min atrás`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h atrás`;
  return `${Math.floor(diff / 86400)}d atrás`;
}
```

Microcopy: rótulos curtos e no imperativo ("Salvar", "Exportar", "Tentar novamente"); títulos descritivos ("Visão Geral", "Novo {ENTIDADE}"); pluralização explícita (`{n} {n === 1 ? "item" : "itens"}`).

---

## 15. Papéis de usuário (quando o sistema tiver permissões)

```ts
const ROLE_LABELS: Record<string, string> = {
  admin:       "Administrador",
  gerente:     "Gerente",
  colaborador: "Colaborador",
};
```
Item de menu bloqueado por papel não desaparece — fica visível e desabilitado (`opacity-40 cursor-not-allowed`), para que o usuário entenda que a função existe.

---

## 16. Checklist de conformidade

Antes de considerar uma tela pronta, confirme:

- [ ] Escala de cinza é `zinc` (exceto `bg-slate-100` do `<main>`)
- [ ] Única cor de ação é `indigo-600`/`indigo-700`
- [ ] Cards: `bg-white p-5 rounded-xl border border-zinc-200 shadow-sm`
- [ ] Inputs com anel de foco indigo e ícone que reage a `group-focus-within`
- [ ] Todo botão interativo tem `transition-*`; primários têm `active:scale-95`
- [ ] Botão só de ícone tem `title`/`aria-label`
- [ ] Ações assíncronas têm `disabled` + `Loader2 animate-spin`
- [ ] Estados de loading (skeleton), vazio e erro implementados
- [ ] Ícones só de `lucide-react`, tamanhos 14/16/18/20
- [ ] Textos em pt-BR; moeda e datas com locale `pt-BR`
- [ ] Sem `alert()`/`confirm()` — Toast e PopupConfirmação
- [ ] Responsivo em `md` e `lg`; `truncate`/`shrink-0` aplicados
- [ ] Marca escrita exatamente como **Nexus Vital**
- [ ] Nenhum arquivo CSS novo criado
