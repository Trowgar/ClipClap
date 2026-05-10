import { auth } from "@/lib/auth";
import { redirect, notFound } from "next/navigation";
import { projectService } from "@clipfast/shared";
import { ProjectDetail } from "@/components/project-detail";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  const project = await projectService.getProjectDetail(id, session.user.id);
  if (!project) notFound();

  const serializedProject = JSON.parse(JSON.stringify(project));

  return <ProjectDetail initialProject={serializedProject} />;
}
