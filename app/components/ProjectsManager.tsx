'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createProject, type ProjectListItem } from '@/app/actions/projects'
import { formatCurrency, formatLongDate } from '@/app/lib/format'
import { Card, EmptyHint } from '@/app/components/AppShell'

const EMOJI_CHOICES = ['🧳', '✈️', '🏖️', '🏔️', '🏠', '🍝', '🎉', '💍', '🚗', '🎄', '🇬🇧', '🇮🇹']
const COLOR_CHOICES = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6']

export function ProjectsManager({ projects }: { projects: ProjectListItem[] }) {
  const router = useRouter()
  const [creating, setCreating] = useState(false)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          onClick={() => setCreating((v) => !v)}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)]"
        >
          {creating ? 'Cancel' : '+ New project'}
        </button>
      </div>

      {creating && (
        <NewProjectForm
          onDone={() => {
            setCreating(false)
            router.refresh()
          }}
        />
      )}

      {projects.length === 0 ? (
        <Card>
          <EmptyHint>
            No projects yet. Create one above, then add transactions from the
            Activity page (select rows → “Add to project”).
          </EmptyHint>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {projects.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard({ p }: { p: ProjectListItem }) {
  const range =
    p.startDate && p.endDate
      ? `${formatLongDate(p.startDate)} – ${formatLongDate(p.endDate)}`
      : p.startDate
        ? `from ${formatLongDate(p.startDate)}`
        : null

  return (
    <Link
      href={`/projects/${p.id}`}
      className="card overflow-hidden transition-colors hover:border-[var(--accent)]"
    >
      <div
        className="relative flex h-28 items-center justify-center"
        style={{ background: `color-mix(in srgb, ${p.color} 18%, var(--surface))` }}
      >
        {p.coverImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.coverImageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-4xl">{p.emoji}</span>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">{p.emoji}</span>
          <span className="truncate font-semibold">{p.name}</span>
        </div>
        {range && <p className="mt-0.5 text-xs text-[var(--muted)]">{range}</p>}
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-lg font-bold tabular-nums">{formatCurrency(p.total)}</span>
          <span className="text-xs text-[var(--muted)]">
            {p.count} {p.count === 1 ? 'item' : 'items'}
          </span>
        </div>
      </div>
    </Link>
  )
}

function NewProjectForm({ onDone }: { onDone: () => void }) {
  const [pending, startTransition] = useTransition()
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState(EMOJI_CHOICES[0])
  const [color, setColor] = useState(COLOR_CHOICES[0])
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const submit = () => {
    if (!name.trim()) return
    startTransition(async () => {
      await createProject({
        name,
        emoji,
        color,
        startDate: startDate || null,
        endDate: endDate || null,
      })
      onDone()
    })
  }

  return (
    <Card title="New project">
      <div className="flex flex-col gap-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name (e.g. UK 2026)"
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
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
        <div className="flex flex-wrap items-center gap-1.5">
          {EMOJI_CHOICES.map((e) => (
            <button
              key={e}
              onClick={() => setEmoji(e)}
              className={`rounded-lg px-2 py-1 text-lg ${
                emoji === e ? 'bg-[var(--surface-2)] ring-1 ring-[var(--accent)]' : 'hover:bg-[var(--surface-2)]'
              }`}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {COLOR_CHOICES.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={`color ${c}`}
              className={`h-6 w-6 rounded-full ${color === c ? 'ring-2 ring-offset-2 ring-offset-[var(--surface)]' : ''}`}
              style={{ background: c, boxShadow: color === c ? `0 0 0 2px ${c}` : undefined }}
            />
          ))}
        </div>
        <div>
          <button
            disabled={pending || !name.trim()}
            onClick={submit}
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-40"
          >
            Create project
          </button>
        </div>
      </div>
    </Card>
  )
}
