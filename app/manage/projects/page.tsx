import { ProjectsManager } from '@/app/components/ProjectsManager'
import { loadProjects } from '@/app/actions/projects'
import { getPersonNames } from '@/app/lib/cardholders'

export const dynamic = 'force-dynamic'

export default async function ManageProjectsPage() {
  const [projects, { selfName, partnerName }] = await Promise.all([
    loadProjects(),
    Promise.resolve(getPersonNames()),
  ])
  return (
    <>
      <p className="mb-4 text-sm text-[var(--muted)]">
        Group transactions into one thing — a trip, a renovation, an event — to
        see its total and compare it over time.
      </p>
      <ProjectsManager projects={projects} selfName={selfName} partnerName={partnerName} />
    </>
  )
}
