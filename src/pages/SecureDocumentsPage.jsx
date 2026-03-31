import { useEffect, useMemo, useState } from 'react';
import { FileUp, LockKeyhole, ShieldCheck } from 'lucide-react';
import PageHero from '../components/PageHero';
import Reveal from '../components/Reveal';
import Seo from '../components/Seo';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
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
  const [error, setError] = useState('');
  const [ndaAccepted, setNdaAccepted] = useState(false);
  const [documentType, setDocumentType] = useState('financials');
  const [note, setNote] = useState('');
  const [files, setFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  async function loadContext() {
    if (!token) {
      setError('This secure document link is missing a token.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await fetch(`/api/secure-documents/request?token=${encodeURIComponent(token)}`);
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to verify this secure document request.');
      }

      setContext(result);
    } catch (loadError) {
      setError(loadError.message || 'Unable to verify this secure document request.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadContext();
  }, [token]);

  const companyLabel = useMemo(() => context?.submission?.company || context?.submission?.name || 'this opportunity', [context]);

  async function handleSubmit(event) {
    event.preventDefault();

    if (files.length === 0) {
      setError('Please choose at least one file to upload.');
      return;
    }

    if (!ndaAccepted) {
      setError('Please confirm the NDA and confidentiality acknowledgement before uploading.');
      return;
    }

    setSubmitting(true);
    setError('');
    setSuccessMessage('');

    try {
      const documents = await Promise.all(
        files.map(async (file) => {
          const payload = await fileToBase64(file);
          return {
            ...payload,
            documentType,
          };
        }),
      );

      const response = await fetch('/api/secure-documents/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token,
          ndaAccepted,
          note,
          documents,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Unable to upload the selected files.');
      }

      setContext(result);
      setFiles([]);
      setNote('');
      setSuccessMessage('Your documents were uploaded successfully.');
    } catch (submitError) {
      setError(submitError.message || 'Unable to upload the selected files.');
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

        {error ? (
          <Reveal className="rounded-[28px] border border-red-200 bg-red-50 p-7 text-sm font-medium leading-7 text-red-700">
            {error}
          </Reveal>
        ) : null}

        {!loading && !error && context ? (
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

              <div className="mt-8 rounded-[24px] border border-line/80 bg-fog/70 p-5">
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-1 h-5 w-5 shrink-0 text-moss" />
                  <p className="text-sm leading-7 text-ink/74">
                    By uploading documents here, you confirm they are being shared in confidence for business review purposes only. This request records NDA acknowledgement when files are submitted.
                  </p>
                </div>
              </div>

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
                  <p className="rounded-2xl border border-moss/20 bg-moss/8 px-4 py-3 text-sm font-medium text-moss">{successMessage}</p>
                ) : null}

                <label className="flex flex-col gap-2 text-sm font-medium text-ink">
                  Document category
                  <select
                    className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss"
                    onChange={(event) => setDocumentType(event.target.value)}
                    value={documentType}
                  >
                    <option value="financials">Financials</option>
                    <option value="teaser">Teaser</option>
                    <option value="cim">CIM / overview</option>
                    <option value="tax-returns">Tax returns</option>
                    <option value="contracts">Contracts</option>
                    <option value="customer-summary">Customer summary</option>
                    <option value="other">Other</option>
                  </select>
                </label>

                <label className="flex flex-col gap-2 text-sm font-medium text-ink">
                  Files
                  <input
                    className="rounded-2xl border border-line bg-white px-4 py-3 text-sm text-ink"
                    multiple
                    onChange={(event) => setFiles(Array.from(event.target.files || []))}
                    type="file"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm font-medium text-ink">
                  Note
                  <textarea
                    className="min-h-[140px] rounded-3xl border border-line bg-white px-4 py-4 text-sm text-ink outline-none transition focus:border-moss"
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Optional context about the files you are sharing"
                    value={note}
                  />
                </label>

                <label className="flex items-start gap-3 rounded-[24px] border border-line/80 bg-fog/70 px-4 py-4 text-sm leading-7 text-ink/74">
                  <input checked={ndaAccepted} className="mt-1 h-4 w-4" onChange={(event) => setNdaAccepted(event.target.checked)} type="checkbox" />
                  <span>I confirm these documents are being shared confidentially for business review and I acknowledge the NDA / confidentiality terms associated with this request.</span>
                </label>

                <button
                  className="inline-flex items-center justify-center rounded-full border border-moss bg-moss px-6 py-3 text-sm font-semibold text-white transition hover:border-pine hover:bg-pine disabled:opacity-50"
                  disabled={submitting}
                  type="submit"
                >
                  {submitting ? 'Uploading...' : 'Upload Documents'}
                </button>
              </form>
            </Reveal>
          </div>
        ) : null}
      </section>
    </>
  );
}
