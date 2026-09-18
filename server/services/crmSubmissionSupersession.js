export const CRM_SUBMISSION_SUPERSEDED = 'CRM_SUBMISSION_SUPERSEDED';
export const CRM_SUPERSESSION_UNAVAILABLE = 'CRM_SUPERSESSION_UNAVAILABLE';

export class CrmSubmissionSupersededError extends Error {
  constructor({ submissionId = '', survivorSubmissionId = '', opportunityId = '' } = {}) {
    super('This CRM record is historical and cannot be changed.');
    this.name = 'CrmSubmissionSupersededError';
    this.code = CRM_SUBMISSION_SUPERSEDED;
    this.status = 409;
    this.submissionId = submissionId;
    this.survivorSubmissionId = survivorSubmissionId;
    this.opportunityId = opportunityId;
  }
}

export class CrmSupersessionUnavailableError extends Error {
  constructor() {
    super('CRM supersession authority is unavailable for this storage provider.');
    this.name = 'CrmSupersessionUnavailableError';
    this.code = CRM_SUPERSESSION_UNAVAILABLE;
    this.status = 503;
    this.submissionId = '';
    this.survivorSubmissionId = '';
    this.opportunityId = '';
  }
}

export async function getCrmSubmissionSupersessionContext({ storage, submissionId } = {}) {
  return storage.getCrmSubmissionSupersessionContext(submissionId);
}

export async function assertCrmSubmissionWritable({ storage, submissionId } = {}) {
  return storage.assertCrmSubmissionWritable(submissionId);
}

export function projectCrmSupersessionHttpError(error) {
  if (error instanceof CrmSubmissionSupersededError) {
    return {
      status: 409,
      body: {
        success: false,
        code: CRM_SUBMISSION_SUPERSEDED,
        error: 'This CRM record is historical and cannot be changed.',
        submissionId: error.submissionId,
        survivorSubmissionId: error.survivorSubmissionId,
        opportunityId: error.opportunityId,
      },
    };
  }
  if (error instanceof CrmSupersessionUnavailableError) {
    return {
      status: 503,
      body: {
        success: false,
        code: CRM_SUPERSESSION_UNAVAILABLE,
        error: 'CRM supersession authority is unavailable for this storage provider.',
      },
    };
  }
  return null;
}
