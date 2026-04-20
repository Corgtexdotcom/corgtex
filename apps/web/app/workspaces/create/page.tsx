import { createWorkspaceAction } from "@/lib/workspace-actions";
import { requirePageActor } from "@/lib/auth";

export const dynamic = "force-dynamic";


export default async function CreateWorkspacePage() {
  await requirePageActor();

  return (
    <main className="login-shell" style={{ maxWidth: 600, margin: "auto", paddingTop: 80 }}>
      <section className="panel">
        <span className="tag">Unified interface</span>
        <h1>Create Workspace</h1>
        <p className="muted">Set up a new workspace for your team.</p>
        
        <form action={createWorkspaceAction} className="stack" style={{ marginTop: 24 }}>
          <label>
            Name
            <input name="name" required placeholder="My Awesome Team" />
          </label>
          <label>
            Slug
            <input name="slug" required pattern="[a-z0-9-]+" placeholder="team-slug" />
          </label>
          <label>
            Description
            <textarea name="description" placeholder="What is this workspace for?" />
          </label>
          <button type="submit">Create workspace</button>
        </form>
      </section>
    </main>
  );
}
