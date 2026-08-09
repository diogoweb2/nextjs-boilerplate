'use client'

import { useEffect, useTransition } from 'react'
import type { AparecidaTransaction } from '@/db/schema'
import { setAparecidaNotSuspicious } from '@/app/actions/aparecida'
import { categoryColor, formatBRL, formatDatePt, type AparecidaFlag } from '@/app/lib/aparecida'

/** Full-detail view of one Aparecida transaction — every field spelled out, nothing truncated. */
export function AparecidaTransactionModal({
  txn,
  flags,
  onClose,
  onChanged,
  onFilterEstablishment,
}: {
  txn: AparecidaTransaction
  flags: AparecidaFlag[]
  onClose: () => void
  onChanged: () => void
  onFilterEstablishment: (description: string) => void
}) {
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const statementUrl = `/api/aparecida/statement/${encodeURIComponent(txn.statementFile)}`

  function toggleNotSuspicious() {
    startTransition(async () => {
      await setAparecidaNotSuspicious(txn.id, !txn.notSuspicious)
      onChanged()
    })
  }

  const fields: { label: string; value: string }[] = [
    { label: 'Data', value: formatDatePt(txn.txnDate) },
    { label: 'Descrição completa', value: txn.description },
    { label: 'Categoria', value: txn.category },
    { label: 'Valor', value: formatBRL(Number(txn.amount)) },
    { label: 'Parcela', value: txn.installment ?? 'À vista' },
    { label: 'Fatura de origem', value: txn.statementFile },
    { label: 'Importado em', value: new Date(txn.createdAt).toLocaleString('pt-BR') },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:py-10"
      role="dialog"
      aria-modal="true"
      aria-label="Detalhes do lançamento"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--border)] text-[var(--foreground)] shadow-xl"
        style={{ background: 'var(--surface)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Detalhes do lançamento</div>
            <div className="text-xs text-[var(--muted)]">Todos os campos, sem cortes.</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-lg leading-none text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Fechar"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">
          <dl className="flex flex-col gap-2.5">
            {fields.map((f) => (
              <div key={f.label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  {f.label}
                </dt>
                <dd className="whitespace-normal break-words text-sm font-medium">{f.value}</dd>
              </div>
            ))}
            <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
              <dt className="w-40 shrink-0 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                Categoria
              </dt>
              <dd>
                <span
                  className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    color: categoryColor(txn.category),
                    background: `color-mix(in srgb, ${categoryColor(txn.category)} 15%, transparent)`,
                  }}
                >
                  {txn.category}
                </span>
              </dd>
            </div>
          </dl>

          {flags.length > 0 && (
            <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] p-3">
              <span className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                Fora do padrão
              </span>
              <ul className="flex flex-col gap-1">
                {flags.map((f) => (
                  <li key={f.code} className="text-sm">
                    {f.label}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] p-3">
            <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 15%, transparent)' }}
              >
                Gerado por IA
              </span>
              Nota sobre o estabelecimento
            </span>
            <p className="whitespace-normal break-words text-sm">
              {txn.aiFeedback ?? 'Ainda não gerada para este lançamento.'}
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <a
              href={statementUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-center text-sm font-medium hover:bg-[var(--surface-2)]"
            >
              Abrir fatura original (PDF)
            </a>
            <a
              href={`${statementUrl}?download=1`}
              className="flex-1 rounded-lg border border-[var(--border)] px-3 py-2 text-center text-sm font-medium hover:bg-[var(--surface-2)]"
            >
              Baixar PDF
            </a>
          </div>

          <button
            type="button"
            disabled={pending}
            onClick={toggleNotSuspicious}
            className="rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
            style={{ background: txn.notSuspicious ? 'var(--muted)' : 'var(--accent)' }}
          >
            {pending ? 'Salvando…' : txn.notSuspicious ? 'Marcar como suspeito novamente' : 'Não é suspeito'}
          </button>

          <button
            type="button"
            onClick={() => onFilterEstablishment(txn.description)}
            className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm font-medium hover:bg-[var(--surface-2)]"
          >
            Ver todas as compras neste estabelecimento
          </button>
        </div>
      </div>
    </div>
  )
}
