import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { jobService } from "@clipfast/shared";
import { UploadZone } from "@/components/upload-zone";
import { JobList } from "@/components/job-list";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const jobs = await jobService.getUserJobs(session.user.id);

  // Serialize for client components
  const serializedJobs = JSON.parse(JSON.stringify(jobs));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Upload a video and get AI-generated clips in minutes
        </p>
      </div>

      <div className="rounded-lg border border-border p-6">
        <UploadZone />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold">Recent Jobs</h2>
        <JobList jobs={serializedJobs} />
      </div>
    </div>
  );
}
