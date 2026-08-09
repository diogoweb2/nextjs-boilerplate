import { AppShell } from '@/app/components/AppShell'
import { AparecidaManager } from '@/app/components/AparecidaManager'
import { loadAparecidaData } from '@/app/actions/aparecida'

export const dynamic = 'force-dynamic'

export default async function AparecidaPage() {
  const data = await loadAparecidaData()
  return (
    <AppShell>
      <div className="mb-5">
        <h1 className="text-xl font-bold tracking-tight">Aparecida</h1>
        <p className="text-sm text-[var(--muted)]">
          Cartão de crédito da Aparecida — isolado do resto do app, só para acompanhar.
        </p>
      </div>
      <AparecidaManager data={data} />
    </AppShell>
  )
}
