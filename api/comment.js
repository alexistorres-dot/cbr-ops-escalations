export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticketKey, comment, author, authorEmail } = req.body;
  if (!ticketKey) return res.status(400).json({ error: 'ticketKey required' });
  const commentText = typeof comment === 'string' ? comment : JSON.stringify(comment);

  // Skip comments that originated from Slack (posted by slack-event.js) to prevent loops
  if (commentText.startsWith('[via Slack]')) return res.status(200).json({ ok: true, skipped: 'slack-sourced' });

  const JIRA_EMAIL      = process.env.JIRA_EMAIL;
  const JIRA_TOKEN      = process.env.JIRA_API_TOKEN;
  const JIRA_BASE       = 'https://getflex.atlassian.net';
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Get the stored Slack thread URL + reporter email from the Jira ticket
  const issueRes = await fetch(`${JIRA_BASE}/rest/api/3/issue/${ticketKey}?fields=customfield_11967,reporter`, { headers });
  const issue    = await issueRes.json();
  const slackUrl = issue.fields?.customfield_11967;

  if (!slackUrl) {
    console.warn('No Slack thread URL found for', ticketKey);
    return res.status(200).json({ ok: false, reason: 'No Slack thread URL stored on ticket' });
  }

  // Parse channel ID and ts from Slack URL
  const match = slackUrl.match(/archives\/([A-Z0-9]+)\/p(\d+)/);
  if (!match) {
    console.warn('Could not parse Slack URL:', slackUrl);
    return res.status(200).json({ ok: false, reason: 'Could not parse Slack URL' });
  }

  const channel   = match[1];
  const tsRaw     = match[2];
  const thread_ts = tsRaw.slice(0, -6) + '.' + tsRaw.slice(-6);

  // Look up Slack ID for the commenter
  let commenterTag = author || 'Someone';
  if (authorEmail && SLACK_BOT_TOKEN) {
    try {
      const r    = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(authorEmail)}`, {
        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
      });
      const data = await r.json();
      if (data.ok && data.user?.id) commenterTag = `<@${data.user.id}>`;
    } catch (e) {
      console.warn('Commenter Slack lookup failed:', e.message);
    }
  }

  // Look up Slack ID for the original submitter (reporter)
  let submitterTag = issue.fields?.reporter?.displayName || '';
  const reporterEmail = issue.fields?.reporter?.emailAddress;
  if (reporterEmail && SLACK_BOT_TOKEN) {
    try {
      const r    = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(reporterEmail)}`, {
        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
      });
      const data = await r.json();
      if (data.ok && data.user?.id) submitterTag = `<@${data.user.id}>`;
    } catch (e) {
      console.warn('Submitter Slack lookup failed:', e.message);
    }
  }

  const text = submitterTag
    ? `💬 ${commenterTag} commented on *${ticketKey}* (submitted by ${submitterTag}):\n${commentText}`
    : `💬 ${commenterTag} commented on *${ticketKey}*:\n${commentText}`;

  const msgRes  = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts, text })
  });

  const msgData = await msgRes.json();
  console.log('Thread reply:', msgData.ok, msgData.error || '');

  return res.status(200).json({ ok: msgData.ok });
}
