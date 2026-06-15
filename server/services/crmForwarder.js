import { getConfig } from '../config.js';

export async function forwardToCrm(submission) {
  const config = getConfig();

  if (!config.crm.webhookUrl) {
    return {
      status: 'skipped',
      error: '',
    };
  }

  let response;

  try {
    response = await fetch(config.crm.webhookUrl, {
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
        opportunity: {
          company: submission.company,
          leadSourceUrl: submission.lead_source_url || submission.listing_url,
          businessWebsite: submission.business_website,
          serviceInterest: submission.service_interest || submission.prospectus_url,
          packageOrBudget: submission.package_budget || submission.asking_price,
          monthlyLeadValue: submission.monthly_lead_value || submission.ttm_revenue,
          leadGoal: submission.lead_goal || submission.ttm_ebitda,
          currentProvider: submission.current_provider || submission.ebitda_multiple,
          conversionIssue: submission.conversion_issue || submission.net_margin,
          businessAge: submission.business_age,
          priorityFit: submission.priority_fit || submission.sba_eligible,
        },
        participants: {
          partner: {
            name: submission.partner_name || submission.broker_name,
            email: submission.partner_email || submission.broker_email,
            phone: submission.partner_phone || submission.broker_phone,
          },
          primaryContact: {
            name: submission.primary_contact_name || submission.seller_name,
            email: submission.primary_contact_email || submission.seller_email,
            phone: submission.primary_contact_phone || submission.seller_phone,
          },
        },
        message: submission.message,
        notes: submission.notes || '',
        meta: submission.metadata,
      }),
    });
  } catch (error) {
    return {
      status: 'failed',
      error: `CRM webhook failed: ${error.message}`,
    };
  }

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
