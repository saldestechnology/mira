import { listNotifications, markRead, unreadCount } from './inbox.mjs';
import { getNotifyPrefs, NOTIFICATION_KINDS, setNotifyPrefs } from './notify.mjs';

export const INBOX_BODY_LIMIT = 8 * 1024;
const READ_IDS_MAX = 100;

/** Tracker's personal inbox and notification preference routes. */
export function createTrackerInboxRoutes({ directory, boardAccess = null, compile, errors }) {
  const { HttpError, badRequest } = errors;

  const routes = [
    compile('GET', 'tracker/inbox', {}, ({ user, query }) => {
      const rawLimit = query.get('limit');
      const limit = rawLimit == null || rawLimit === '' ? 30 : Number(rawLimit);
      if (!Number.isFinite(limit)) throw badRequest('limit must be a number');
      const before = query.get('before');
      const result = listNotifications({
        directory,
        user,
        limit,
        before: before || null,
        unreadOnly: query.get('unread') === '1',
        boardAccess,
      });
      return [200, result];
    }),

    compile('GET', 'tracker/inbox/unread', {}, ({ user }) => [
      200,
      { unread: unreadCount(directory, user, { boardAccess }) },
    ]),

    compile('POST', 'tracker/inbox/read', { body: true, maxBody: INBOX_BODY_LIMIT }, ({ user, body }) => {
      const all = body.all === true;
      const ids = body.ids;
      if (all) {
        if (ids !== undefined) throw badRequest('Provide ids or all, not both');
      } else if (!Array.isArray(ids) || ids.length > READ_IDS_MAX || ids.some((id) => typeof id !== 'string' || !id)) {
        throw badRequest(`ids must be an array of up to ${READ_IDS_MAX} notification ids, or set all to true`);
      }
      const result = markRead({ directory, user, ids: ids ?? [], all });
      return [200, { ...result, unread: unreadCount(directory, user, { boardAccess }) }];
    }),

    compile('GET', 'tracker/notification-prefs', {}, ({ user }) => [
      200,
      { kinds: NOTIFICATION_KINDS, prefs: getNotifyPrefs(directory, user.id) },
    ]),

    compile('PUT', 'tracker/notification-prefs', { body: true, maxBody: INBOX_BODY_LIMIT }, ({ user, body }) => {
      try {
        setNotifyPrefs(directory, user.id, body.prefs);
      } catch (error) {
        if (error?.code === 'invalid_input') throw badRequest(error.message);
        throw error;
      }
      return [200, { kinds: NOTIFICATION_KINDS, prefs: getNotifyPrefs(directory, user.id) }];
    }),
  ];

  return routes.map((route) => ({
    ...route,
    handler: async (context) => {
      try {
        return await route.handler(context);
      } catch (error) {
        if (error?.code === 'invalid_input') throw badRequest(error.message);
        if (error instanceof HttpError) throw error;
        throw error;
      }
    },
  }));
}
