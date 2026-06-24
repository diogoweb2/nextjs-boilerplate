import { AppShell } from '@/app/components/AppShell'
import { ProjectsManager } from '@/app/components/ProjectsManager'
import { loadProjects } from '@/app/actions/projects'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const projects = await loadProjects()
  return (
    <AppShell>
      <div className="mb-4">
        <h1 className="text-xl font-bold tracking-tight">Projects</h1>
        <p className="text-sm text-[var(--muted)]">
          Group transactions into one thing — a trip, a renovation, an event — to
          see its total and compare it over time.
        </p>
      </div>
      <ProjectsManager projects={projects} />
    </AppShell>
  )
}
