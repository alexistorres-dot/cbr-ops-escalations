export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { ticketKey, commentId, commenter } = req.body;
  if (!ticketKey) return res.status(400).json({ error: 'ticketKey required' });

  const JIRA_EMAIL      = process.env.JIRA_EMAIL;
  const JIRA_TOKEN      = process.env.JIRA_API_TOKEN;
  const JIRA_BASE       = 'https://getflex.atlassian.net';
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Get Slack thread URL + reporter from the Jira ticket
  const issueRes  = await fetch(`${JIRA_BASE}/rest/api/3/issue/${ticketKey}?fields=customfield_11967,reporter`, { headers });
  const issue     = await issueRes.json();
  const slackUrl  = issue.fields?.customfield_11967;

  if (!slackUrl) {
    console.warn('No Slack thread URL found for', ticketKey);
    return res.status(200).json({ ok: false, reason: 'No Slack thread URL stored on ticket' });
  }

  const match = slackUrl.match(/archives\/([A-Z0-9]+)\/p(\d+)/);
  if (!match) {
    console.warn('Could not parse Slack URL:', slackUrl);
    return res.status(200).json({ ok: false, reason: 'Could not parse Slack URL' });
  }

  const channel   = match[1];
  const tsRaw     = match[2];
  const thread_ts = tsRaw.slice(0, -6) + '.' + tsRaw.slice(-6);

  // Fetch comment by ID to get text and created timestamp
  let commentText    = '';
  let commentCreated = null;
  if (commentId) {
    try {
      const cRes  = await fetch(`${JIRA_BASE}/rest/api/3/issue/${ticketKey}/comment/${commentId}`, { headers });
      const cData = await cRes.json();
      commentCreated = cData.created;
      commentText    = extractText(cData.body);
      if (commentText.startsWith('[via Slack]')) return res.status(200).json({ ok: true, skipped: 'slack-sourced' });
    } catch (e) {
      console.warn('Comment fetch failed:', e.message);
    }
  }

  // Find attachments on the issue created around the same time as this comment
  const attachmentsToSync = await findCommentAttachments(JIRA_BASE, ticketKey, commentCreated, headers);

  // Look up Slack IDs for commenter and reporter
  let commenterTag = commenter || 'Someone';
  let submitterTag = issue.fields?.reporter?.displayName || '';
  const reporterEmail = issue.fields?.reporter?.emailAddress;
  if (SLACK_BOT_TOKEN) {
    const [ct, st] = await Promise.all([
      lookupSlackTag(commenter, SLACK_BOT_TOKEN),
      lookupSlackTag(reporterEmail, SLACK_BOT_TOKEN)
    ]);
    if (ct) commenterTag = ct;
    if (st) submitterTag = st;
  }

  const excerpt = commentText ? (commentText.length > 500 ? commentText.slice(0, 500) + '…' : commentText) : '';
  const text = submitterTag
    ? `💬 ${commenterTag} commented on *${ticketKey}* (submitted by ${submitterTag}):${excerpt ? `\n\n${excerpt}` : ''}`
    : `💬 ${commenterTag} commented on *${ticketKey}*:${excerpt ? `\n\n${excerpt}` : ''}`;

  const msgRes  = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, thread_ts, text })
  });
  const msgData = await msgRes.json();
  console.log('Thread reply:', msgData.ok, msgData.error || '', ticketKey);

  // Upload attachments to Slack thread
  for (const att of attachmentsToSync) {
    try {
      const fileRes = await fetch(att.content, { headers: { 'Authorization': `Basic ${auth}` } });
      const buffer  = await fileRes.arrayBuffer();
      await uploadFileToSlack(buffer, att.filename, att.mimeType, channel, thread_ts, SLACK_BOT_TOKEN);
      console.log('Uploaded attachment to Slack:', att.filename);
    } catch (e) {
      console.warn('Attachment upload to Slack failed:', e.message, att.filename);
    }
  }

  return res.status(200).json({ ok: msgData.ok });
}

function extractText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  return (node.content || []).map(extractText).join('');
}


async function findCommentAttachments(jiraBase, ticketKey, commentCreated, headers) {
  if (!commentCreated) return [];
  try {
    const attRes  = await fetch(`${jiraBase}/rest/api/3/issue/${ticketKey}?fields=attachment`, { headers });
    const attData = await attRes.json();
    const allAtts = attData.fields?.attachment || [];
    const commentTime = new Date(commentCreated).getTime();
    const recent = allAtts.filter(a => Math.abs(new Date(a.created).getTime() - commentTime) < 120000);
    console.log('Attachments on ticket:', allAtts.length, 'recent:', recent.length);
    return recent;
  } catch (e) {
    console.warn('Attachment list fetch failed:', e.message);
    return [];
  }
}

async function lookupSlackTag(email, token) {
  if (!email) return null;
  try {
    const res  = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    return data.ok && data.user?.id ? `<@${data.user.id}>` : null;
  } catch { return null; }
}

async function uploadFileToSlack(fileBuffer, filename, mimeType, channel, thread_ts, token) {
  const buf  = Buffer.from(fileBuffer);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mimeType || 'application/octet-stream' }), filename);
  form.append('filename', filename);
  form.append('channels', channel);
  form.append('thread_ts', thread_ts);
  const res  = await fetch('https://slack.com/api/files.upload', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form
  });
  const data = await res.json();
  console.log('files.upload:', data.ok, data.error || '', filename);
  if (!data.ok) throw new Error(`files.upload: ${data.error}`);
  return data.file?.id;
}
