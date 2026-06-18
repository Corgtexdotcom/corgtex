"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { setWorkspaceChatPageContext, type WorkspaceChatCrmPageContext } from "../chat/page-context";

export function CrmChatPageContext({ context }: { context: Omit<WorkspaceChatCrmPageContext, "route"> & { route?: string } }) {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const contextKey = useMemo(() => JSON.stringify(context), [context]);

  useEffect(() => {
    const route = `${pathname}${queryString ? `?${queryString}` : ""}`;
    const parsedContext = JSON.parse(contextKey) as Omit<WorkspaceChatCrmPageContext, "route">;
    const pageContext: WorkspaceChatCrmPageContext = {
      ...parsedContext,
      route,
    };
    setWorkspaceChatPageContext({ pageContext });
    return () => setWorkspaceChatPageContext({ pageContext: null });
  }, [contextKey, pathname, queryString]);

  return null;
}
