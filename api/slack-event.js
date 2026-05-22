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

  // Fetch the parent Slack message and extract the Jira ticket key from it
  let ticketKey = null;
  try {
    const histRes  = await fetch(`https://slack.com/api/conversations.history?channel=${event.channel}&latest=${event.thread_ts}&limit=1&inclusive=true`, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
    });
    const histData = await histRes.json();
    const parentMsg = histData.messages?.[0];
    console.log('Parent message:', parentMsg?.text?.slice(0, 200));
    const match = parentMsg?.text?.match(/browse\/(CBR-\d+)/);
    if (match) ticketKey = match[1];
  } catch (e) {
    console.warn('Failed to fetch parent message:', e.message);
  }

  if (!ticketKey) {
    console.log('No Jira ticket key found in parent message');
    return res.status(200).end();
  }

  console.log('Found ticket:', ticketKey);

  // Get the Slack user's email and look up their Jira account ID
  let authorName      = 'Someone';
  let authorAccountId = null;
  try {
    const userRes  = await fetch(`https://slack.com/api/users.info?user=${event.user}`, {
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
    });
    const userData = await userRes.json();
    if (userData.ok) {
      authorName = userData.user.real_name || userData.user.name;
      const email = userData.user.profile?.email;
      if (email) {
        const jiraUserRes  = await fetch(`${JIRA_BASE}/rest/api/3/user/search?query=${encodeURIComponent(email)}`, { headers });
        const jiraUsers    = await jiraUserRes.json();
        const match        = jiraUsers.find(u => u.emailAddress?.toLowerCase() === email.toLowerCase());
        if (match?.accountId) authorAccountId = match.accountId;
      }
    }
  } catch (e) {
    console.warn('User lookup failed:', e.message);
  }

  // Build ADF comment with @mention if we have the account ID
  const authorContent = authorAccountId
    ? [{ type: 'mention', attrs: { id: authorAccountId, text: `@${authorName}` } }, { type: 'text', text: ' (via Slack):' }]
    : [{ type: 'text', text: `[via Slack] ${authorName}:`, marks: [{ type: 'strong' }] }];

  const commentBody = {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: authorContent },
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
