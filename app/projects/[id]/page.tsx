import { notFound } from 'next/navigation'
import { AppShell } from '@/app/components/AppShell'
import { ProjectDetailView } from '@/app/components/ProjectDetail'
import { loadProjectDetail, loadProjectCandidates } from '@/app/actions/projects'

export const dynamic = 'force-dynamic'

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const projectId = Number(id)
  if (!Number.isInteger(projectId)) notFound()

  const detail = await loadProjectDetail(projectId)
  if (!detail) notFound()
  const candidates = await loadProjectCandidates(projectId)

  return (
    <AppShell>
      <ProjectDetailView detail={detail} candidates={candidates} />
    </AppShell>
  )
}
