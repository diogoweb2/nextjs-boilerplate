'use client'

import { useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  updateProject,
  deleteProject,
  addTransactionsToProject,
  removeTransactionsFromProject,
  setProjectCover,
  removeProjectCover,
  type ProjectDetail,
  type ProjectTxn,
} from '@/app/actions/projects'
import { formatCurrency, formatLongDate } from '@/app/lib/format'
import { Card } from '@/app/components/AppShell'

export function ProjectDetailView({
  detail,
  candidates,
}: {
  detail: ProjectDetail
  candidates: ProjectTxn[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [editing, setEditing] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refresh = () => router.refresh()
  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      refresh()
    })

  const range =
    detail.startDate && detail.endDate
      ? `${formatLongDate(detail.startDate)} – ${formatLongDate(detail.endDate)}`
      : detail.startDate
        ? `from ${formatLongDate(detail.startDate)}`
        : null

  const maxCat = Math.max(1, ...detail.byCategory.map((c) => Math.abs(c.total)))

  const onCoverPicked = (file: File | null) => {
    if (!file) return
    const fd = new FormData()
    fd.set('projectId', String(detail.id))
    fd.set('file', file)
    run(() => setProjectCover(fd))
  }

  return (
    <div className={`flex flex-col gap-4 ${pending ? 'opacity-70 transition-opacity' : ''}`}>
      <div className="flex items-center justify-between">
        <Link href="/projects" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
          ← Projects
        </Link>
        <button
          onClick={() => setEditing((v) => !v)}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>

      {/* Cover + header */}
      <div className="card overflow-hidden">
        <div
          className="relative flex h-40 items-center justify-center"
          style={{ background: `color-mix(in srgb, ${detail.color} 18%, var(--surface))` }}
        >
          {detail.coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={detail.coverImageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="text-6xl">{detail.emoji}</span>
          )}
          <div className="absolute bottom-2 right-2 flex gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => onCoverPicked(e.target.files?.[0] ?? null)}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-lg bg-black/50 px-2.5 py-1 text-xs font-medium text-white backdrop-blur"
            >
              {detail.coverImageUrl ? 'Replace photo' : '+ Cover photo'}
            </button>
            {detail.coverImageUrl && (
              <button
                onClick={() => run(() => removeProjectCover(detail.id))}
                className="rounded-lg bg-black/50 px-2.5 py-1 text-xs font-medium text-white backdrop-blur"
              >
                Remove
              </button>
            )}
          </div>
        </div>
        <div className="p-4">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{detail.emoji}</span>
            <h1 className="text-xl font-bold tracking-tight">{detail.name}</h1>
          </div>
          {range && <p className="mt-0.5 text-sm text-[var(--muted)]">{range}</p>}
          {detail.notes && <p className="mt-2 text-sm text-[var(--foreground)]">{detail.notes}</p>}
          <div className="mt-3 flex items-baseline gap-2">
            <span className="text-2xl font-bold tabular-nums">{formatCurrency(detail.total)}</span>
            <span className="text-sm text-[var(--muted)]">
              · {detail.members.length} {detail.members.length === 1 ? 'item' : 'items'}
            </span>
          </div>
        </div>
      </div>

      {editing && <EditForm detail={detail} onSaved={refresh} onDeleted={() => router.push('/projects')} />}

      {/* Breakdowns */}
      {detail.byCategory.length > 0 && (
        <Card title="By category">
          <div className="flex flex-col gap-2">
            {detail.byCategory.map((c) => (
              <div key={c.name} className="flex items-center gap-3">
                <span className="w-28 shrink-0 truncate text-sm">{c.name}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${(Math.abs(c.total) / maxCat) * 100}%`, background: c.color }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right text-sm font-medium tabular-nums">
                  {formatCurrency(c.total)}
                </span>
              </div>
            ))}
          </div>
          {detail.byPerson.length > 1 && (
            <div className="mt-4 flex flex-wrap gap-4 border-t border-[var(--border)] pt-3 text-sm">
              {detail.byPerson.map((p) => (
                <span key={p.person} className="text-[var(--muted)]">
                  {p.person}:{' '}
                  <span className="font-medium text-[var(--foreground)] tabular-nums">
                    {formatCurrency(p.total)}
                  </span>
                </span>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Suggested candidates */}
      {candidates.length > 0 && (
        <Card
          title={`Suggested — review (${candidates.length})`}
          action={
            <button
              onClick={() => run(() => addTransactionsToProject(detail.id, candidates.map((c) => c.id)))}
              className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-xs font-medium text-[var(--accent-fg)]"
            >
              Add all
            </button>
          }
        >
          <p className="mb-3 text-xs text-[var(--muted)]">
            In the project’s dates but we can’t tell if they were abroad (Amex / bank
            rows carry no country). Add the ones that belong to this project.
          </p>
          <div className="card divide-y divide-[var(--border)] overflow-hidden">
            {candidates.map((t) => (
              <MemberRow
                key={t.id}
                t={t}
                actionLabel="+ Add"
                onAction={() => run(() => addTransactionsToProject(detail.id, [t.id]))}
              />
            ))}
          </div>
        </Card>
      )}

      {/* Members */}
      <Card title={`Transactions (${detail.members.length})`}>
        {detail.members.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--muted)]">
            No transactions yet. Add them from the{' '}
            <Link href="/transactions" className="text-[var(--accent)] underline">
              Activity page
            </Link>{' '}
            (select rows → “Add to project”).
          </p>
        ) : (
          <div className="card divide-y divide-[var(--border)] overflow-hidden">
            {detail.members.map((t) => (
              <MemberRow
                key={t.id}
                t={t}
                actionLabel="✕ Remove"
                onAction={() => run(() => removeTransactionsFromProject(detail.id, [t.id]))}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

function MemberRow({
  t,
  actionLabel,
  onAction,
}: {
  t: ProjectTxn
  actionLabel: string
  onAction: () => void
}) {
  return (
    <div className="flex items-center gap-3 p-3">
      <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: t.categoryColor }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{t.merchantName}</div>
        <div className="text-xs text-[var(--muted)]">
          {formatLongDate(t.txnDate)} · {t.categoryName} · {t.source}
          {t.country ? ` · ${t.country}` : ''} · {t.person}
        </div>
      </div>
      <span className={`shrink-0 text-sm font-semibold tabular-nums ${t.amount < 0 ? 'text-[var(--positive)]' : ''}`}>
        {t.amount < 0 ? '+' : ''}
        {formatCurrency(Math.abs(t.amount))}
      </span>
      <button
        onClick={onAction}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--foreground)]"
      >
        {actionLabel}
      </button>
    </div>
  )
}

function EditForm({
  detail,
  onSaved,
  onDeleted,
}: {
  detail: ProjectDetail
  onSaved: () => void
  onDeleted: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState(detail.name)
  const [emoji, setEmoji] = useState(detail.emoji)
  const [startDate, setStartDate] = useState(detail.startDate ?? '')
  const [endDate, setEndDate] = useState(detail.endDate ?? '')
  const [notes, setNotes] = useState(detail.notes ?? '')

  const save = () =>
    startTransition(async () => {
      await updateProject(detail.id, {
        name,
        emoji,
        startDate: startDate || null,
        endDate: endDate || null,
        notes,
      })
      onSaved()
    })

  const remove = () =>
    startTransition(async () => {
      await deleteProject(detail.id)
      onDeleted()
    })

  return (
    <Card title="Edit project">
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            className="w-14 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-2 text-center text-lg"
          />
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Project name"
            className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
            Start
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
            End
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm"
            />
          </label>
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          rows={2}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
        <div className="flex items-center justify-between">
          <button
            disabled={pending}
            onClick={save}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-40"
          >
            Save
          </button>
          <button
            disabled={pending}
            onClick={() => {
              if (confirm(`Delete “${detail.name}”? Transactions are kept; only the project is removed.`)) remove()
            }}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-[var(--negative)] hover:bg-[var(--surface-2)]"
          >
            Delete project
          </button>
        </div>
      </div>
    </Card>
  )
}
