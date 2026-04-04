import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 주간 백업: 모든 테이블 데이터를 JSON으로 내보내기
// Vercel Cron 또는 수동: GET /api/export-data?key=ADMIN_API_KEY
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  // 인증
  const cronAuth = req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  const keyAuth = req.query.key === process.env.ADMIN_API_KEY;
  if (!cronAuth && !keyAuth) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const tables = ['accounts', 'credits', 'transactions', 'jobs', 'promo_codes', 'promo_usage', 'admin_settings'];
    const backup = { exported_at: new Date().toISOString(), tables: {} };

    for (const table of tables) {
      const { data, error } = await sb.from(table).select('*');
      if (error) {
        backup.tables[table] = { error: error.message };
      } else {
        backup.tables[table] = { count: data.length, data };
      }
    }

    // Supabase Storage에 저장 시도
    const fileName = `backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const jsonStr = JSON.stringify(backup, null, 2);

    const { error: uploadError } = await sb.storage
      .from('backups')
      .upload(fileName, jsonStr, { contentType: 'application/json', upsert: false });

    if (uploadError) {
      // Storage 버킷이 없으면 직접 JSON 반환
      console.warn('Storage upload failed:', uploadError.message);
      return res.status(200).json({
        message: 'Backup generated (storage unavailable)',
        storage_error: uploadError.message,
        backup
      });
    }

    // 30일 이상 된 백업 삭제
    const { data: files } = await sb.storage.from('backups').list();
    if (files) {
      const cutoff = Date.now() - 30 * 86400000;
      for (const f of files) {
        if (new Date(f.created_at).getTime() < cutoff) {
          await sb.storage.from('backups').remove([f.name]);
        }
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
