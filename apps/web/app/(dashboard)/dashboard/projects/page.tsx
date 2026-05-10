import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { projectService } from "@clipfast/shared";
import { ProjectTable } from "@/components/project-list";

export default async function ProjectsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const projects = await projectService.getUserProjects(session.user.id);
  const serializedProjects = JSON.parse(JSON.stringify(projects));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Projects</h1>
        <p className="text-sm text-muted-foreground">
          Browse every video you have turned into clips.
        </p>
      </div>

      <ProjectTable projects={serializedProjects} />
    </div>
  );
}
