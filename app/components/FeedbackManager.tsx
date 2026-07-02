'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Card, EmptyHint } from '@/app/components/AppShell'
import {
  createFeedbackItem,
  updateFeedbackItem,
  setFeedbackItemCompleted,
  reorderFeedbackItems,
} from '@/app/actions/feedback'
import type { FeedbackItem, FeedbackKind } from '@/db/schema'

const KIND_META: Record<FeedbackKind, { label: string; icon: string }> = {
  bug: { label: 'Bug', icon: '🐛' },
  idea: { label: 'Idea', icon: '💡' },
}

type Filter = 'all' | FeedbackKind | 'completed'

type DragProps = {
  dragging: boolean
  isOver: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragEnd: () => void
  onDrop: (e: React.DragEvent) => void
}

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'bug', label: 'Bugs' },
  { value: 'idea', label: 'Ideas' },
  { value: 'completed', label: 'Completed' },
]

const INPUT_CLASS =
  'rounded-lg border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm text-[var(--foreground)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]'

/**
 * Drag-to-reorder, same pattern as GoalsManager's useReorder: an optimistic
 * local order that reshuffles live while dragging, persisted on drop. Only
 * offered on the unfiltered ("All") view — reordering a filtered subset can't
 * unambiguously map back onto sortOrder for the hidden items.
 */
function useReorder(items: FeedbackItem[]) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const serverOrder = items.map((i) => i.id)
  const serverKey = serverOrder.join(',')
  const [order, setOrder] = useState<number[]>(serverOrder)
  const orderRef = useRef<number[]>(order)
  orderRef.current = order
  const dragId = useRef<number | null>(null)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)

  useEffect(() => {
    setOrder(serverOrder)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey])

  const byId = new Map(items.map((i) => [i.id, i]))
  const ordered = order.map((id) => byId.get(id)).filter((i): i is FeedbackItem => Boolean(i))

  const moveBefore = (sourceId: number, targetId: number) => {
    if (sourceId === targetId) return
    setOrder((prev) => {
      const next = prev.filter((id) => id !== sourceId)
      const idx = next.indexOf(targetId)
      if (idx === -1) return prev
      next.splice(idx, 0, sourceId)
      return next
    })
  }

  const persist = () => {
    const id = dragId.current
    dragId.current = null
    setDraggingId(null)
    setOverId(null)
    if (id === null) return
    const current = orderRef.current
    if (current.join(',') !== serverKey) {
      startTransition(async () => {
        await reorderFeedbackItems(current)
        router.refresh()
      })
    }
  }

  const dragPropsFor = (id: number): DragProps => ({
    dragging: draggingId === id,
    isOver: overId === id && draggingId !== id,
    onDragStart: (e: React.DragEvent) => {
      dragId.current = id
      setDraggingId(id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault()
      if (dragId.current !== null) {
        setOverId(id)
        moveBefore(dragId.current, id)
      }
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDragEnd: persist,
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      persist()
    },
  })

  return { ordered, dragPropsFor }
}

function buildCopyText(items: FeedbackItem[]): string {
  const bugs = items.filter((i) => i.kind === 'bug')
  const ideas = items.filter((i) => i.kind === 'idea')
  const sections: string[] = []
  bugs.forEach((item, i) => sections.push(`Bug ${i + 1}:\n${item.label}`))
  ideas.forEach((item, i) => sections.push(`Improvement ${i + 1}:\n${item.label}`))
  return sections.join('\n\n')
}

export function FeedbackManager({ items }: { items: FeedbackItem[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [filter, setFilter] = useState<Filter>('all')
  const [newKind, setNewKind] = useState<FeedbackKind>('bug')
  const [newLabel, setNewLabel] = useState('')
  const [copied, setCopied] = useState(false)

  const active = items.filter((i) => !i.completed)
  const completed = items.filter((i) => i.completed)

  const { ordered, dragPropsFor } = useReorder(active)
  const visible =
    filter === 'all'
      ? ordered
      : filter === 'completed'
        ? completed
        : ordered.filter((i) => i.kind === filter)
  const canReorder = filter === 'all' && active.length > 1

  const run = (fn: () => Promise<void>) =>
    startTransition(async () => {
      await fn()
      router.refresh()
    })

  const submit = () => {
    if (!newLabel.trim()) return
    run(async () => {
      await createFeedbackItem(newKind, newLabel)
      setNewLabel('')
    })
  }

  const copyActive = async () => {
    const text = buildCopyText(active)
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className={`flex flex-col gap-4 ${pending ? 'opacity-70 transition-opacity' : ''}`}>
      <Card>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value as FeedbackKind)}
              className={INPUT_CLASS}
              aria-label="Type"
            >
              <option value="bug">🐛 Bug</option>
              <option value="idea">💡 Idea</option>
            </select>
            <button
              disabled={!newLabel.trim()}
              onClick={submit}
              className="ml-auto rounded-lg bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-fg)] disabled:opacity-40"
            >
              Add
            </button>
          </div>
          <textarea
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            }}
            placeholder="What's the bug or idea? (Cmd/Ctrl+Enter to add)"
            rows={3}
            className={`${INPUT_CLASS} resize-y`}
          />
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 self-start rounded-xl bg-[var(--surface-2)] p-1">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                filter === f.value
                  ? 'bg-[var(--background)] text-[var(--foreground)] shadow-sm'
                  : 'text-[var(--muted)] hover:text-[var(--foreground)]'
              }`}
            >
              {f.label}
              {f.value === 'completed' && completed.length > 0 ? ` (${completed.length})` : ''}
            </button>
          ))}
        </div>
        <button
          onClick={copyActive}
          disabled={active.length === 0}
          className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--surface-2)] disabled:opacity-40"
        >
          {copied ? 'Copied!' : 'Copy for AI'}
        </button>
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyHint>
            {filter === 'all'
              ? 'Nothing tracked yet — add a bug or idea above.'
              : filter === 'completed'
                ? 'Nothing completed yet.'
                : `No ${filter}s right now.`}
          </EmptyHint>
        </Card>
      ) : (
        <div className="card divide-y divide-[var(--border)] overflow-hidden">
          {visible.map((item) => (
            <FeedbackRow
              key={item.id}
              item={item}
              drag={canReorder ? dragPropsFor(item.id) : undefined}
              onKind={(kind) => run(() => updateFeedbackItem(item.id, { kind }))}
              onLabel={(label) => run(() => updateFeedbackItem(item.id, { label }))}
              onComplete={() => run(() => setFeedbackItemCompleted(item.id, !item.completed))}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FeedbackRow({
  item,
  drag,
  onKind,
  onLabel,
  onComplete,
}: {
  item: FeedbackItem
  drag?: DragProps
  onKind: (kind: FeedbackKind) => void
  onLabel: (label: string) => void
  onComplete: () => void
}) {
  const [label, setLabel] = useState(item.label)
  const meta = KIND_META[item.kind]

  return (
    <div
      onDragEnter={drag?.onDragEnter}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      className={`flex items-center gap-2 p-3 transition-opacity ${drag?.dragging ? 'opacity-40' : ''} ${
        drag?.isOver ? 'ring-2 ring-inset ring-[var(--accent)]' : ''
      }`}
    >
      {drag && (
        <span
          draggable
          onDragStart={drag.onDragStart}
          onDragEnd={drag.onDragEnd}
          title="Drag to reorder"
          aria-label="Drag to reorder"
          className="cursor-grab select-none px-1 text-[var(--muted)] hover:text-[var(--foreground)] active:cursor-grabbing"
        >
          ⠿
        </span>
      )}
      <button
        onClick={onComplete}
        title={item.completed ? 'Add back to active list' : 'Mark complete'}
        aria-label={item.completed ? 'Add back to active list' : 'Mark complete'}
        className={`h-5 w-5 shrink-0 rounded-full border-2 ${
          item.completed
            ? 'border-[var(--positive)] bg-[var(--positive)]/15'
            : 'border-[var(--border)] hover:border-[var(--positive)] hover:bg-[var(--positive)]/15'
        }`}
      />
      <select
        value={item.kind}
        onChange={(e) => onKind(e.target.value as FeedbackKind)}
        title="Type"
        className="shrink-0 rounded-md border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-xs text-[var(--muted)] outline-none focus:border-[var(--accent)]"
      >
        <option value="bug">🐛 Bug</option>
        <option value="idea">💡 Idea</option>
      </select>
      <textarea
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => label.trim() && label !== item.label && onLabel(label)}
        rows={1}
        className={`min-w-0 flex-1 resize-y rounded-md bg-transparent px-1 py-0.5 text-sm outline-none hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] ${
          item.completed ? 'text-[var(--muted)] line-through' : ''
        }`}
      />
      <span className="hidden shrink-0 text-xs text-[var(--muted)] sm:inline">{meta.label}</span>
    </div>
  )
}
