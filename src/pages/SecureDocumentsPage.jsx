import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FileUp, LockKeyhole, ShieldCheck } from 'lucide-react';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';

const acceptedDocumentTypes = [
  '.pdf',
  '.xlsx',
  '.xls',
  '.csv',
  '.docx',
  '.doc',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.zip',
].join(',');

const documentCategories = [
  ['financials', 'Financials'], ['teaser', 'Teaser'], ['cim', 'CIM / overview'], ['nda', 'NDA'],
  ['p_and_l', 'P&L'], ['tax_returns', 'Tax returns'], ['balance_sheet', 'Balance sheet'],
  ['customer_concentration', 'Customer concentration'], ['payroll', 'Payroll'], ['lease', 'Lease'],
  ['contracts', 'Contracts'], ['equipment', 'Equipment'], ['owner_role', 'Owner role'],
  ['management_depth', 'Management depth'], ['sba_fit', 'SBA fit'], ['other', 'Other'],
];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve({
        name: file.name,
        mimeType: file.type || '',
        sizeBytes: file.size,
        contentBase64: base64,
      });
    };
    reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export default function SecureDocumentsPage() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get('token') || '');
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [contextError, setContextError] = useState('');
  const [submissionError, setSubmissionError] = useState('');
  const [ndaAccepted, setNdaAccepted] = useState(false);
  const [documentType, setDocumentType] = useState('financials');
  const [fileCategories, setFileCategories] = useState({});
  const [completeRequest, setCompleteRequest] = useState(false);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  const loadContext = useCallback(async () => {
    if (!token) {
      setContextError('This secure document link is missing a token.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setContextError('');

    try {
      const response = await fetch(`/api/secure-documents/request?token=${encodeURIComponent(token)}`);
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to verify this secure document request.');
      }

      setContext(result);
    } catch (loadError) {
      setContextError(loadError.message || 'Unable to verify this secure document request.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadContext();
  }, [loadContext]);

  const companyLabel = useMemo(() => context?.submission?.company || context?.submission?.name || 'this opportunity', [context]);

  async function handleSubmit(event) {
    event.preventDefault();

    if (files.length === 0) {
      setSubmissionError('Please choose at least one file to upload.');
      return;
    }

    if (!ndaAccepted) {
      setSubmissionError('Please confirm the confidentiality acknowledgement before uploading.');
      return;
    }

    setSubmitting(true);
    setSubmissionError('');
    setSuccessMessage('');

    try {
      const documents = await Promise.all(
        files.map(async (file, index) => {
          const payload = await fileToBase64(file);
          return {
            ...payload,
            documentType: fileCategories[index] || documentType,
          };
        }),
      );

      const response = await fetch('/api/secure-documents/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Secure-Upload-Token': token,
        },
        body: JSON.stringify({
          token,
          ndaAccepted,
          note,
          documents,
          completeRequest,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to upload the selected files.');
      }

      setContext(result);
      setFiles([]);
      setFileCategories({});
      setCompleteRequest(false);
      setNote('');
      setNdaAccepted(false);
      setSuccessMessage(completeRequest ? 'Your documents were uploaded and this request is now complete.' : 'Your documents were uploaded. You can add another batch or finish the request when ready.');
    } catch (submitError) {
      setSubmissionError(submitError.message || 'Unable to upload the selected files.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Seo description="Secure document handoff for Uckele Group." keywords="secure document upload" noindex title="Secure Documents | Uckele Group" />

      <PageHero
        description="Use this page to share sensitive business materials through a private upload request. This page is intended for confidential seller documents only."
        eyebrow="Secure Document Handoff"
        title="Confidential uploads for business review"
      />

      <section className="section-shell mt-10 pb-8">
        {loading ? (
          <Reveal className="panel p-7 text-sm leading-7 text-ink/70">Verifying secure upload request...</Reveal>
        ) : null}

        {contextError ? (
          <Reveal className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm font-medium leading-7 text-red-700 sm:p-7">
            <p role="alert">{contextError}</p>
            {token ? (
              <button
                className="mt-4 inline-flex min-h-[44px] items-center justify-center rounded-full border border-red-300 bg-white px-5 py-2 text-sm font-semibold text-red-800"
                onClick={loadContext}
                type="button"
              >
                Try Again
              </button>
            ) : null}
          </Reveal>
        ) : null}

        {!loading && !contextError && context ? (
          <div className="grid gap-8 lg:grid-cols-[0.92fr_1.08fr]">
            <Reveal className="panel p-7 sm:p-8">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                <LockKeyhole className="h-5 w-5" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold text-ink">Secure request details</h2>
              <div className="mt-5 space-y-3 text-sm leading-7 text-ink/72">
                <p><strong>Company:</strong> {companyLabel}</p>
                <p><strong>Request expires:</strong> {new Date(context.request.expires_at).toLocaleString()}</p>
                <p><strong>Request status:</strong> {context.request.status}</p>
                <p><strong>Contact:</strong> {context.request.contact_name || context.request.email}</p>
              </div>

              <div className="mt-8 rounded-2xl border border-line/80 bg-fog/70 p-5">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-1 h-5 w-5 shrink-0 text-moss" />
                  <p className="text-sm leading-7 text-ink/74">
                    Access is restricted to authorized Uckele Group administrators. Files are used only to evaluate the potential transaction, retained while the opportunity and applicable legal obligations require them, and then deleted from the active vault under the secure retention process. Access-controlled backup copies expire under the backup retention schedule. This request records your confidentiality acknowledgement with each batch.
                  </p>
                </div>
              </div>

              {context.request.requested_checklist?.length ? (
                <div className="mt-8">
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Requested-document checklist</p>
                  <ul className="mt-4 space-y-2">
                    {context.request.requested_checklist.map((item) => (
                      <li className="flex items-center justify-between rounded-2xl border border-line/80 bg-fog/60 px-4 py-3 text-sm" key={item.category}>
                        <span className="font-medium text-ink">{item.label}</span>
                        <span className={item.received ? 'text-emerald-700' : 'text-amber-700'}>{item.received ? `Received (${item.receivedCount})` : 'Requested'}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="mt-8">
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-moss">Files already uploaded</p>
                {context.documents?.length ? (
                  <div className="mt-4 space-y-3">
                    {context.documents.map((document) => (
                      <div className="rounded-2xl border border-line/80 bg-white/70 px-4 py-3 text-sm text-ink/74" key={document.id}>
                        <p className="font-semibold text-ink">{document.original_name}</p>
                        <p className="mt-1 text-xs uppercase tracking-[0.14em] text-moss/70">{document.document_type}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-sm leading-7 text-ink/68">No documents uploaded yet.</p>
                )}
              </div>
            </Reveal>

            <Reveal className="panel p-7 sm:p-8" delay={120}>
              {['documents-received', 'completed', 'revoked'].includes(context.request.status) ? (
                <div className="space-y-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-moss/8 text-moss">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <h2 className="text-2xl font-semibold text-ink">{context.request.status === 'revoked' ? 'Upload link revoked' : 'Documents received'}</h2>
                  <p className="text-sm leading-7 text-ink/72">
                    {context.request.status === 'revoked'
                      ? 'This link is no longer active. Please contact Uckele Group if you need a replacement request.'
                      : 'This secure request is complete. Please contact Uckele Group if you need a new upload link for additional files.'}
                  </p>
                </div>
              ) : (
              <form className="space-y-5" onSubmit={handleSubmit}>
                <div>
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-clay/12 text-clay">
                    <FileUp className="h-5 w-5" />
                  </div>
                  <h2 className="mt-5 text-2xl font-semibold text-ink">Upload documents</h2>
                  <p className="mt-3 text-base leading-7 text-ink/72">
                    Typical files include a teaser, CIM, recent financials, customer summaries, contracts, or other supporting materials relevant to the conversation.
                  </p>
                </div>

                {successMessage ? (
                  <p aria-live="polite" className="rounded-2xl border border-moss/20 bg-moss/8 px-4 py-3 text-sm font-medium text-moss">{successMessage}</p>
                ) : null}

                {submissionError ? (
                  <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700" role="alert">
                    {submissionError}
                  </p>
                ) : null}

                <label className="flex flex-col gap-2 text-sm font-medium text-ink">
                  Document category
                  <select
                    className="form-control"
                    onChange={(event) => setDocumentType(event.target.value)}
                    value={documentType}
                  >
                    {documentCategories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>

                <label className="flex flex-col gap-2 text-sm font-medium text-ink">
                  Files
                  <input
                    accept={acceptedDocumentTypes}
                    className="w-full rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink"
                    multiple
                    onChange={(event) => {
                      const selectedFiles = Array.from(event.target.files || []);
                      setFiles(selectedFiles);
                      setFileCategories(Object.fromEntries(selectedFiles.map((_, index) => [index, documentType])));
                      setSubmissionError('');
                    }}
                    type="file"
                  />
                </label>

                {files.length > 0 ? (
                  <div className="space-y-3" aria-label="Per-file categories">
                    {files.map((file, index) => (
                      <label className="grid gap-2 rounded-2xl border border-line/80 bg-fog/60 p-4 text-sm font-medium text-ink sm:grid-cols-[1fr_15rem] sm:items-center" key={`${file.name}-${file.lastModified}-${index}`}>
                        <span className="min-w-0 truncate">{file.name}</span>
                        <span>
                          <span className="sr-only">Category for {file.name}</span>
                          <select
                            aria-label={`Category for ${file.name}`}
                            className="form-control"
                            onChange={(event) => setFileCategories((current) => ({ ...current, [index]: event.target.value }))}
                            value={fileCategories[index] || documentType}
                          >
                            {documentCategories.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : null}

                <label className="flex flex-col gap-2 text-sm font-medium text-ink">
                  Note
                  <textarea
                    className="min-h-[140px] rounded-2xl border border-line bg-white px-4 py-4 text-sm text-ink outline-none transition focus:border-moss"
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Optional context about the files you are sharing"
                    value={note}
                  />
                </label>

                <label className="flex items-start gap-3 rounded-2xl border border-line/80 bg-fog/70 px-4 py-4 text-sm leading-7 text-ink/74">
                  <input
                    checked={ndaAccepted}
                    className="mt-1 h-4 w-4"
                    onChange={(event) => {
                      setNdaAccepted(event.target.checked);
                      setSubmissionError('');
                    }}
                    type="checkbox"
                  />
                  <span>I confirm these documents are being shared confidentially for business review and acknowledge this confidentiality notice.</span>
                </label>

                <label className="flex items-start gap-3 rounded-2xl border border-moss/20 bg-moss/5 px-4 py-4 text-sm leading-7 text-ink/74">
                  <input checked={completeRequest} className="mt-1 h-4 w-4 accent-moss" onChange={(event) => setCompleteRequest(event.target.checked)} type="checkbox" />
                  <span><strong>Finish this request after this batch.</strong> Leave this unchecked if you plan to return with more files using the same link.</span>
                </label>

                <button
                  className="inline-flex w-full items-center justify-center rounded-full border border-moss bg-moss px-6 py-3 text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:opacity-50 sm:w-auto"
                  disabled={submitting}
                  type="submit"
                >
                  {submitting ? 'Uploading...' : 'Upload Documents'}
                </button>
              </form>
              )}
            </Reveal>
          </div>
        ) : null}
      </section>
    </>
  );
}
