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
  let commentAdf     = null;
  if (commentId) {
    try {
      const cRes  = await fetch(`${JIRA_BASE}/rest/api/3/issue/${ticketKey}/comment/${commentId}`, { headers });
      const cData = await cRes.json();
      commentCreated = cData.created;
      commentAdf     = cData.body;
      commentText    = extractText(cData.body);
      if (commentText.startsWith('[via Slack]')) return res.status(200).json({ ok: true, skipped: 'slack-sourced' });
    } catch (e) {
      console.warn('Comment fetch failed:', e.message);
    }
  }

  // Find attachments on the issue created around the same time as this comment
  const attachmentsToSync = await findCommentAttachments(JIRA_BASE, ticketKey, commentCreated, commentAdf, headers);

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

function findMediaIds(node, ids = []) {
  if (!node) return ids;
  if (node.type === 'media' && node.attrs?.id) ids.push(node.attrs.id);
  (node.content || []).forEach(c => findMediaIds(c, ids));
  return ids;
}

async function findCommentAttachments(jiraBase, ticketKey, commentCreated, commentAdf, headers) {
  if (!commentCreated) return [];
  const mediaIds = findMediaIds(commentAdf);
  if (mediaIds.length === 0) return [];
  try {
    const attRes  = await fetch(`${jiraBase}/rest/api/3/issue/${ticketKey}?fields=attachment`, { headers });
    const attData = await attRes.json();
    const allAtts = attData.fields?.attachment || [];
    const commentTime = new Date(commentCreated).getTime();
    return allAtts.filter(a => Math.abs(new Date(a.created).getTime() - commentTime) < 120000);
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
  const length = fileBuffer.byteLength;
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, length })
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`getUploadURLExternal: ${urlData.error}`);
  await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': mimeType || 'application/octet-stream' },
    body: fileBuffer
  });
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ id: urlData.file_id }], channel_id: channel, thread_ts })
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`completeUploadExternal: ${completeData.error}`);
  return urlData.file_id;
}
