import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 주간 백업: 모든 테이블 데이터를 JSON으로 Supabase Storage에 저장
// Vercel Cron 또는 수동: GET /api/export-data?key=ADMIN_API_KEY
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const cronAuth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const keyAuth = req.query.key === process.env.ADMIN_API_KEY;
  if (!cronAuth && !keyAuth) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const tables = ['accounts', 'credits', 'transactions', 'jobs', 'promo_codes', 'promo_usage', 'admin_settings'];
    const selectOverrides = { accounts: 'id, email, name, company, is_admin, created_at' };
    const backup = { exported_at: new Date().toISOString(), tables: {} };

    // Parallel table reads instead of sequential
    const results = await Promise.allSettled(
      tables.map(async (table) => {
        const cols = selectOverrides[table] || '*';
        const { data, error } = await sb.from(table).select(cols);
        return { table, data, error };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        const { table, data, error } = r.value;
        backup.tables[table] = error ? { error: error.message } : { count: data.length, data };
      } else {
        backup.tables['unknown'] = { error: r.reason?.message || 'Promise rejected' };
      }
    }

    const fileName = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const jsonStr = JSON.stringify(backup, null, 2);

    const { error: uploadError } = await sb.storage
      .from('backups')
      .upload(fileName, jsonStr, { contentType: 'application/json', upsert: false });

    if (uploadError) {
      // SECURITY: Never return full backup data in HTTP response
      console.error('Storage upload failed:', uploadError.message);
      return res.status(500).json({
        error: 'Backup storage failed',
        storage_error: uploadError.message,
        tables: Object.keys(backup.tables).map(t => `${t}: ${backup.tables[t].count || 0} rows`),
      });
    }

    // Parallel cleanup of old backups (30+ days)
    const { data: files } = await sb.storage.from('backups').list();
    if (files) {
      const cutoff = Date.now() - 30 * 86400000;
      const toDelete = files.filter(f => new Date(f.created_at).getTime() < cutoff).map(f => f.name);
      if (toDelete.length > 0) {
        await sb.storage.from('backups').remove(toDelete);
      }
    }

    return res.status(200).json({
      message: `Backup saved: ${fileName}`,
      tables: Object.keys(backup.tables).map(t => `${t}: ${backup.tables[t].count || 0} rows`)
    });

  } catch (err) {
    console.error('Export error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
