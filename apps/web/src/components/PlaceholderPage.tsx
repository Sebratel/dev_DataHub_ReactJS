// Página provisória para módulos dos próximos sprints.
export default function PlaceholderPage({ title, sprint }: { title: string; sprint: string }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <div className="mt-6 rounded-xl border border-dashed border-zinc-300 p-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
        Em construção — chega no {sprint} do roadmap do MVP.
      </div>
    </div>
  )
}
