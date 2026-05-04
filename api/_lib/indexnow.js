// IndexNow: Notify search engines (Bing, Yandex, and Google via partnership)
// when a new job page is published or updated.
// No OAuth or service account needed — just a static key file hosted on the domain.
// Key file: https://www.canadayouthhire.ca/{INDEXNOW_KEY}.txt  (content = key)

const INDEXNOW_KEY = process.env.INDEXNOW_KEY || 'c7f2a9e4b1d3f8a5c2e7b4d9f1a6c3e8';
const BASE_URL = 'https://www.canadayouthhire.ca';

/**
 * Notify IndexNow of a new or updated job URL.
 * Fire-and-forget — never throws, never blocks job creation.
 * @param {string|number} jobId
 */
export async function notifyIndexNow(jobId) {
  if (!jobId) return;
  const jobUrl = `${BASE_URL}/jobs/${jobId}`;
  try {
    const resp = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: 'www.canadayouthhire.ca',
        key: INDEXNOW_KEY,
        keyLocation: `${BASE_URL}/${INDEXNOW_KEY}.txt`,
        urlList: [jobUrl]
      })
    });
    console.log('[IndexNow] submitted', jobUrl, '→ status', resp.status);
  } catch (e) {
    // Non-critical: IndexNow failure should never block job creation
    console.warn('[IndexNow] ping failed (non-critical):', e.message);
  }
}
