const SUBJECTS = Object.freeze({
  assigned: (key) => `${key} was assigned to you`,
  mentioned: (key) => `You were mentioned on ${key}`,
  commented: (key) => `New comment on ${key}`,
  status_changed: (key) => `${key} changed status`,
  due_soon: (key) => `${key} is due soon`,
  relation_changed: (key) => `${key} has a new relation`,
  integration_activity: (key) => `New activity on ${key}`,
});

const FOOTER = 'You get this email because ticket notifications are turned on for your account. You can change that under Notifications in Tabula.';

function singleLine(value, max) {
  const text = Array.from(String(value ?? '').replace(/\s+/gu, ' ').trim());
  return text.length > max ? text.slice(0, max).join('') : text.join('');
}

function sentenceFor({ kind, key, title, actor }) {
  if (kind === 'due_soon') return `${key} ${title} is due soon.`;
  if (kind === 'assigned') return actor ? `${actor} assigned ${key} to you: ${title}.` : `${key} was assigned to you: ${title}.`;
  if (kind === 'mentioned') return actor ? `${actor} mentioned you on ${key}: ${title}.` : `${key} mentioned you: ${title}.`;
  if (kind === 'commented') return actor ? `${actor} commented on ${key}: ${title}.` : `${key} has a new comment: ${title}.`;
  if (kind === 'status_changed') return actor ? `${actor} changed the status of ${key}: ${title}.` : `${key} changed status: ${title}.`;
  if (kind === 'relation_changed') return actor ? `${actor} changed a relation on ${key}: ${title}.` : `${key} has a new relation: ${title}.`;
  return actor ? `${actor} added activity to ${key}: ${title}.` : `New activity on ${key}: ${title}.`;
}

/** Build the instance-side copy and relay template parameters for one ticket notification. */
/** @param {{ kind: string, key: string, title: string, actor?: string | null, preview?: string | null, link: string }} options */
export function noticeMail({ kind, key, title, actor = null, preview = null, link }) {
  const safeKey = singleLine(key, 64);
  const safeTitle = singleLine(title, 200);
  const safeActor = actor == null ? null : singleLine(actor, 80) || null;
  const safePreview = preview == null ? null : singleLine(preview, 140) || null;
  const safeLink = singleLine(link, 2048);
  const subject = (SUBJECTS[kind] ?? SUBJECTS.integration_activity)(safeKey);
  const text = [
    sentenceFor({ kind, key: safeKey, title: safeTitle, actor: safeActor }),
    ...(safePreview ? [`"${safePreview}"`] : []),
    `Open the ticket: ${safeLink}`,
    FOOTER,
  ].join('\n\n');
  return { subject, text };
}
