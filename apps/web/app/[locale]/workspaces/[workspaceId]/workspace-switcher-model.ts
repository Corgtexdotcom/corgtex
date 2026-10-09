import type { SwitchableWorkspace } from "./WorkspaceSwitcher";

export function workspaceHomeHref(locale: string, workspaceId: string) {
  return `/${encodeURIComponent(locale)}/workspaces/${encodeURIComponent(workspaceId)}`;
}

export function workspaceOptions(
  workspaces: SwitchableWorkspace[],
  query: string,
) {
  const names = new Map<string, number>();
  const slugs = new Map<string, number>();
  for (const workspace of workspaces) {
    names.set(workspace.name, (names.get(workspace.name) ?? 0) + 1);
    slugs.set(workspace.slug, (slugs.get(workspace.slug) ?? 0) + 1);
  }
  const search = query.trim().toLocaleLowerCase();
  return workspaces
    .map((workspace) => ({
      ...workspace,
      disambiguator:
        (names.get(workspace.name) ?? 0) > 1
          ? (slugs.get(workspace.slug) ?? 0) > 1
            ? `${workspace.slug} · ${workspace.id}`
            : workspace.slug
          : null,
    }))
    .filter((workspace) =>
      `${workspace.name} ${workspace.slug}`
        .toLocaleLowerCase()
        .includes(search),
    );
}
