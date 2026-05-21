export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticketKey, comment, author } = req.body;
  if (!ticketKey || !comment) return res.status(400).json({ error: 'ticketKey and comment required' });

  const JIRA_EMAIL      = process.env.JIRA_EMAIL;
  const JIRA_TOKEN      = process.env.JIRA_API_TOKEN;
  const JIRA_BASE       = 'https://getflex.atlassian.net';
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Get the stored Slack thread URL from the Jira ticket
  const issueRes = await fetch(`${JIRA_BASE}/rest/api/3/issue/${ticketKey}?fields=customfield_11967`, { headers });
  const issue    = await issueRes.json();
  const slackUrl = issue.fields?.customfield_11967;

  if (!slackUrl) {
    console.warn('No Slack thread URL found for', ticketKey);
    return res.status(200).json({ ok: false, reason: 'No Slack thread URL stored on ticket' });
  }

  // Parse channel ID and ts from Slack URL
  // Format: https://workspace.slack.com/archives/CHANNELID/p1234567890123456
  const match = slackUrl.match(/archives\/([A-Z0-9]+)\/p(\d+)/);
  if (!match) {
    console.warn('Could not parse Slack URL:', slackUrl);
    return res.status(200).json({ ok: false, reason: 'Could not parse Slack URL' });
  }

  const channel   = match[1];
  const tsRaw     = match[2];
  const thread_ts = tsRaw.slice(0, -6) + '.' + tsRaw.slice(-6);

  // Post as a thread reply under the original submission message
  const msgRes  = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel,
      thread_ts,
      text: `💬 *${author || 'Someone'}* commented on *${ticketKey}*:\n${comment}`
    })
  });

  const msgData = await msgRes.json();
  console.log('Thread reply:', msgData.ok, msgData.error || '');

  return res.status(200).json({ ok: msgData.ok });
}
