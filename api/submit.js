export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { submitter, cid, customerName, description, productType, odLink, slackLink, devtoolLink } = req.body;

  if (!submitter?.trim()) return res.status(400).json({ error: 'Your Flex email is required.' });
  if (!/^[A-Za-z0-9]{28}$/.test(cid)) return res.status(400).json({ error: 'Invalid CID format.' });
  if (!customerName?.trim()) return res.status(400).json({ error: 'Customer name is required.' });
  if (!description?.trim()) return res.status(400).json({ error: 'Description is required.' });
  if (!productType) return res.status(400).json({ error: 'Product type is required.' });

  const PRODUCT_TYPE_IDS = {
    'FlexAnywhere': '13404',
    'Aptexx':       '13369',
    'Entrata':      '13402',
    'MRI':          '13403',
    'P2P':          '13405',
    'Portal':       '13406',
    'RealPage':     '13407',
    'Rentmanager':  '13408',
    'Resman':       '13409',
    'Yardi':        '13410',
    'Appfolio':     '13435',
    'Zego':         '13501',
    'AMC':          '14228',
    'Move In':      '13412',
    'N/A':          '13411',
  };

  const productTypeId = PRODUCT_TYPE_IDS[productType];
  if (!productTypeId) return res.status(400).json({ error: 'Invalid product type.' });

  const JIRA_EMAIL    = process.env.JIRA_EMAIL;
  const JIRA_TOKEN    = process.env.JIRA_API_TOKEN;
  const JIRA_BASE     = 'https://getflex.atlassian.net';
  const SLACK_WEBHOOK = process.env.OPS_SLACK_WEBHOOK_URL;
  const auth    = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const headers = { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };

  // Look up submitter display name
  let submitterName = submitter.trim();
  let submitterAccountId = null;
  try {
    const userRes = await fetch(`${JIRA_BASE}/rest/api/3/user/search?query=${encodeURIComponent(submitter.trim())}`, { headers });
    const users   = await userRes.json();
    const match   = users.find(u => u.emailAddress?.toLowerCase() === submitter.trim().toLowerCase());
    if (match?.displayName) submitterName = match.displayName;
    if (match?.accountId)   submitterAccountId = match.accountId;
  } catch (e) {
    console.warn('Submitter lookup failed:', e.message);
  }

  // Fetch active sprint for board 51
  let sprintId = null;
  try {
    const sprintRes  = await fetch(`${JIRA_BASE}/rest/agile/1.0/board/51/sprint?state=active`, { headers });
    const sprintData = await sprintRes.json();
    const activeSprint = sprintData.values?.[0];
    if (activeSprint?.id) sprintId = activeSprint.id;
    console.log('Active sprint:', activeSprint?.name, '→ id', sprintId);
  } catch (e) {
    console.warn('Sprint lookup failed:', e.message);
  }

  const summary = `${cid} // ${customerName.trim()}`;

  const descriptionDoc = {
    type: 'doc', version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Submitted by: ', marks: [{ type: 'strong' }] }, { type: 'text', text: submitterName }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Submission date: ', marks: [{ type: 'strong' }] }, { type: 'text', text: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Escalation Details:', marks: [{ type: 'strong' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: description.trim() }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Ticket created via ops-escalation web form', marks: [{ type: 'em' }] }] },
    ]
  };

  const fields = {
    project:           { key: 'CBR' },
    issuetype:         { id: '10242' },
    summary,
    description:       descriptionDoc,
    customfield_11965: { id: productTypeId },
    ...(sprintId ? { customfield_10020: sprintId } : {}),
    ...(odLink?.trim()      ? { customfield_11966: odLink.trim() }      : {}),
    ...(slackLink?.trim()   ? { customfield_11967: slackLink.trim() }   : {}),
    ...(devtoolLink?.trim() ? { customfield_11968: devtoolLink.trim() } : {}),
  };

  console.log('FIELDS:', JSON.stringify(fields));

  const createRes = await fetch(`${JIRA_BASE}/rest/api/3/issue`, {
    method: 'POST', headers, body: JSON.stringify({ fields })
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    console.error('Jira create failed:', err);
    return res.status(500).json({ error: 'Failed to create Jira ticket. Check logs for details.' });
  }

  const { key: ticketKey } = await createRes.json();
  const ticketUrl = `${JIRA_BASE}/browse/${ticketKey}`;

  // Set reporter post-creation
  if (submitterAccountId) {
    try {
      await fetch(`${JIRA_BASE}/rest/api/3/issue/${ticketKey}`, {
        method: 'PUT', headers,
        body: JSON.stringify({ fields: { reporter: { id: submitterAccountId } } })
      });
    } catch (e) {
      console.warn('Reporter update failed:', e.message);
    }
  }

  // Post to #cs-ops-escalations
  if (SLACK_WEBHOOK) {
    let slackTag = submitterName;
    const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
    if (SLACK_BOT_TOKEN) {
      try {
        const slackRes  = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(submitter.trim())}`, {
          headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` }
        });
        const slackData = await slackRes.json();
        if (slackData.ok && slackData.user?.id) slackTag = `<@${slackData.user.id}>`;
      } catch (e) {
        console.warn('Slack user lookup failed:', e.message);
      }
    }

    const excerpt = description.length > 200 ? description.slice(0, 200) + '…' : description;
    await fetch(SLACK_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `🔺 *New Payment Ops Escalation submitted*\n\n*Submitted by:* ${slackTag}\n*CID:* ${cid}\n*Customer:* ${customerName.trim()}\n*Product Type:* ${productType}\n\n*Escalation:* "${excerpt}"\n\nJira: ${ticketUrl}`
      })
    });
  }

  return res.status(200).json({ success: true, ticketKey, ticketUrl });
}
