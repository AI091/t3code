import { buildProjectGroups, selectProjectGroupingSettings } from "../logicalProject";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings, useLegacySidebarEnabled } from "./useSettings";

/**
 * The project group the sidebar is scoped to, or null when it lists every
 * project. The sidebar's New button defaults into it so the thread lands in the
 * list the user is looking at. The legacy sidebar never shows the scope, so it
 * never applies.
 */
export function useSidebarProjectScope() {
  const projectScopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  if (legacySidebarEnabled || projectScopeKey === null) return null;
  return (
    buildProjectGroups({
      projects,
      settings: projectGroupingSettings,
      preferredEnvironmentId: primaryEnvironmentId,
    }).find((group) => group.key === projectScopeKey) ?? null
  );
}
