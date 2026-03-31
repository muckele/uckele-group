import { getConfig } from '../config.js';

export async function forwardToCrm(submission) {
  const config = getConfig();

  if (!config.crm.webhookUrl) {
    return {
      status: 'skipped',
      error: '',
    };
  }

  const response = await fetch(config.crm.webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.crm.webhookSecret ? { 'X-Webhook-Secret': config.crm.webhookSecret } : {}),
    },
    body: JSON.stringify({
      type: 'website_lead',
      id: submission.id,
      source: submission.source,
      submittedAt: submission.created_at,
      contact: {
        name: submission.name,
        email: submission.email,
        phone: submission.phone,
        company: submission.company,
        role: submission.role,
      },
      workflow: {
        leadType: submission.lead_type,
        priority: submission.priority,
        tags: submission.tags || [],
        assignee: submission.assigned_to,
        followUpState: submission.follow_up_state,
        nextActionAt: submission.next_action_at,
      },
      deal: {
        company: submission.company,
        listingUrl: submission.listing_url,
        businessWebsite: submission.business_website,
        prospectusUrl: submission.prospectus_url,
        askingPrice: submission.asking_price,
        ttmRevenue: submission.ttm_revenue,
        ttmEbitda: submission.ttm_ebitda,
        ebitdaMultiple: submission.ebitda_multiple,
        netMargin: submission.net_margin,
        businessAge: submission.business_age,
        sbaEligible: submission.sba_eligible,
      },
      participants: {
        broker: {
          name: submission.broker_name,
          email: submission.broker_email,
          phone: submission.broker_phone,
        },
        seller: {
          name: submission.seller_name,
          email: submission.seller_email,
          phone: submission.seller_phone,
        },
      },
      message: submission.message,
      notes: submission.notes || '',
      meta: submission.metadata,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return {
      status: 'failed',
      error: `CRM webhook failed with ${response.status}: ${text.slice(0, 240)}`,
    };
  }

  return {
    status: 'sent',
    error: '',
  };
}
