import { notFound } from 'next/navigation'
import { AppShell } from '@/app/components/AppShell'
import { ProjectDetailView } from '@/app/components/ProjectDetail'
import {
  loadProjectDetail,
  loadProjectCandidates,
  loadAutoFillReviews,
} from '@/app/actions/projects'
import { getPersonNames } from '@/app/lib/cardholders'

export const dynamic = 'force-dynamic'

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const projectId = Number(id)
  if (!Number.isInteger(projectId)) notFound()

  const [detail, candidates, autoFillReviews, { selfName, partnerName }] = await Promise.all([
    loadProjectDetail(projectId),
    loadProjectCandidates(projectId),
    loadAutoFillReviews(projectId),
    Promise.resolve(getPersonNames()),
  ])
  if (!detail) notFound()

  return (
    <AppShell>
      <ProjectDetailView
        detail={detail}
        candidates={candidates}
        autoFillReviews={autoFillReviews}
        selfName={selfName}
        partnerName={partnerName}
      />
    </AppShell>
  )
}
