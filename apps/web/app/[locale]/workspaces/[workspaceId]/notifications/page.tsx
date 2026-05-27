import { countUnreadNotifications, listNotifications } from "@corgtex/domain";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { requirePageActor } from "@/lib/auth";
import { MarkdownExcerpt } from "@/lib/components/MarkdownRenderer";
import { resolveWorkspaceEntityUrl } from "@/lib/workspace-entity-url";
import { markAllNotificationsReadAction, markNotificationReadAction } from "../actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

type NotificationFilter = "all" | "unread";

function notificationHref(workspaceId: string, filter: NotificationFilter, page = 1) {
  const params = new URLSearchParams();
  if (filter === "unread") params.set("filter", filter);
  if (page > 1) params.set("page", String(page));

  const query = params.toString();
  return `/workspaces/${workspaceId}/notifications${query ? `?${query}` : ""}`;
}

function parseFilter(value: string | undefined): NotificationFilter {
  return value === "unread" ? "unread" : "all";
}

function parsePage(value: string | undefined) {
  const page = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function formatNotificationKind(type: string, entityType: string | null) {
  const raw = entityType || type || "Notification";
  return raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export default async function NotificationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ filter?: string; page?: string }>;
}) {
  const { workspaceId } = await params;
  const { filter: filterParam, page: pageParam } = await searchParams;
  const actor = await requirePageActor();
  const t = await getTranslations("notificationsPage");
  const format = await getFormatter();
  const filter = parseFilter(filterParam);
  const page = parsePage(pageParam);
  const skip = (page - 1) * PAGE_SIZE;
  const userId = actor.kind === "user" ? actor.user.id : null;

  const [notificationsResult, unreadCount] = await Promise.all([
    listNotifications(actor, workspaceId, {
      unreadOnly: filter === "unread",
      take: PAGE_SIZE + 1,
      skip,
    }),
    userId ? countUnreadNotifications(userId, workspaceId) : Promise.resolve(0),
  ]);

  const hasNextPage = notificationsResult.length > PAGE_SIZE;
  const notifications = notificationsResult.slice(0, PAGE_SIZE);

  return (
    <div className="notifications-page">
      <header className="ws-page-header notifications-header">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p className="muted">{t("unreadSummary", { count: unreadCount })}</p>
        </div>
        {unreadCount > 0 && (
          <form action={markAllNotificationsReadAction}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <button type="submit" className="secondary">{t("markAllRead")}</button>
          </form>
        )}
      </header>

      <div className="notifications-toolbar">
        <div className="notifications-tabs" role="tablist" aria-label={t("tabsLabel")}>
          <Link
            href={notificationHref(workspaceId, "all")}
            className={filter === "all" ? "active" : ""}
            role="tab"
            aria-selected={filter === "all"}
          >
            {t("tabAll")}
          </Link>
          <Link
            href={notificationHref(workspaceId, "unread")}
            className={filter === "unread" ? "active" : ""}
            role="tab"
            aria-selected={filter === "unread"}
          >
            {t("tabUnread", { count: unreadCount })}
          </Link>
        </div>
      </div>

      {notifications.length === 0 ? (
        <section className="notifications-empty">
          <h2>{filter === "unread" ? t("emptyUnread") : t("emptyAll")}</h2>
        </section>
      ) : (
        <ul className="notifications-list">
          {notifications.map((notification) => {
            const href = resolveWorkspaceEntityUrl(workspaceId, notification.entityType, notification.entityId);
            const isUnread = !notification.readAt;
            const absoluteCreatedAt = format.dateTime(notification.createdAt, {
              dateStyle: "medium",
              timeStyle: "short",
            });

            return (
              <li key={notification.id} className={`notification-row ${isUnread ? "notification-row-unread" : ""}`}>
                <span className="notification-status-dot" aria-hidden="true" />
                <div className="notification-row-main">
                  <div className="notification-row-head">
                    <div className="notification-title-group">
                      <div className="notification-kicker">
                        <span>{formatNotificationKind(notification.type, notification.entityType)}</span>
                        {isUnread && <span className="notification-unread-label">{t("unread")}</span>}
                      </div>
                      {href ? (
                        <Link href={href} className="notification-title">
                          {notification.title}
                        </Link>
                      ) : (
                        <span className="notification-title">{notification.title}</span>
                      )}
                    </div>
                    <time className="notification-time" dateTime={notification.createdAt.toISOString()} title={absoluteCreatedAt} suppressHydrationWarning>
                      {format.relativeTime(notification.createdAt)}
                    </time>
                  </div>

                  {notification.bodyMd && (
                    <div className="notification-body">
                      <MarkdownExcerpt markdown={notification.bodyMd} maxLength={220} />
                    </div>
                  )}

                  <div className="notification-row-footer">
                    <span>{absoluteCreatedAt}</span>
                    {href && (
                      <Link href={href} className="notification-related-link">
                        {t("openRelated")}
                      </Link>
                    )}
                  </div>
                </div>

                {isUnread && (
                  <form action={markNotificationReadAction} className="notification-row-action">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="notificationId" value={notification.id} />
                    <button type="submit" className="secondary small">{t("markRead")}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(page > 1 || hasNextPage) && (
        <nav className="notifications-pagination" aria-label={t("paginationLabel")}>
          {page > 1 ? (
            <Link href={notificationHref(workspaceId, filter, page - 1)} className="secondary small">
              {t("previous")}
            </Link>
          ) : (
            <span />
          )}
          {hasNextPage && (
            <Link href={notificationHref(workspaceId, filter, page + 1)} className="secondary small">
              {t("next")}
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
