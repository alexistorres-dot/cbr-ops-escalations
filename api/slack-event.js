export default async function handler(req, res) {
  // Slack URL verification handshake
  if (req.body?.type === 'url_verification') {
    return res.status(200).json({ challenge: req.body.challenge });
  }

  if (req.method !== 'POST') return res.status(405).end();

  const event = req.body?.event;
  if (!event || event.type !== 'message') return res.status(200).end();

  // Skip bot messages (prevents loop when comment.js posts back to Slack)
  if (event.bot_id || event.subtype) return res.status(200).end();

  // Only process thread replies, not parent messages
  if (!event.thread_ts || event.ts === event.thread_ts) return res.status(200).end();

  const JIRA_EMAIL      = process.env.JIRA_EMAIL;
  const JIRA_TOKEN      = process.env.JIRA_API_TOKEN;
  const JIRA_BASE       = 'https://getflex.atlassian.net';
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Build the Slack thread URL to find the matching Jira ticket
  const tsCompact = event.thread_ts.replace('.', '');
  const jql       = `project = CBR AND "Slack Thread Link" ~ "${tsCompact}"`;
  console.log('JQL:', jql);

  const searchRes  = await fetch(`${JIRA_BASE}/rest/api/3/issue/search?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=1`, { headers });
  const searchText = await searchRes.text();
  console.log('Search response:', searchRes.status, searchText.slice(0, 500));
  const searchData = JSON.parse(searchText);
  const issue      = searchData.issues?.[0];

  if (!issue) {
    console.log('No Jira ticket found for thread ts:', tsCompact);
    return res.status(200).end();
  }

  const ticketKey = issue.key;

  // Get the Slack user's name
  let authorName = 'Someone';
  try {
    const userRes  = await fetch(`https://slack.com/api/users.info?user=${event.user}`, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
    });
    const userData = await userRes.json();
    if (userData.ok) authorName = userData.user.real_name || userData.user.name;
  } catch (e) {
    console.warn('Slack user lookup failed:', e.message);
  }

  // Post as Jira comment — prefix marks it as from Slack so comment.js skips re-posting
  const commentBody = {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: `[via Slack] ${authorName}:`, marks: [{ type: 'strong' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: event.text }] }
    ]
  };

  const commentRes = await fetch(`${JIRA_BASE}/rest/api/3/issue/${ticketKey}/comment`, {
    method: 'POST', headers,
    body: JSON.stringify({ body: commentBody })
  });

  console.log('Jira comment posted:', commentRes.status, ticketKey, authorName);
  return res.status(200).end();
}
