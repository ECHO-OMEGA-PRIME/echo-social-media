import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = {
  DB: D1Database;
  CACHE: KVNamespace;
  ECHO_API_KEY: string;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
};

const app = new Hono<{ Bindings: Env }>();

function uid(): string { return crypto.randomUUID(); }
function sanitize(s: string, max = 5000): string { return (s || '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max); }
function sanitizeBody(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? sanitize(v) : v;
  return out;
}

interface RLState { c: number; t: number; }
async function rateLimit(kv: KVNamespace, key: string, limit: number, windowSec = 60): Promise<boolean> {
  const now = Date.now();
  const raw = await kv.get<RLState>(`rl:${key}`, 'json');
  if (!raw || (now - raw.t) > windowSec * 1000) {
    await kv.put(`rl:${key}`, JSON.stringify({ c: 1, t: now }), { expirationTtl: windowSec * 2 });
    return true;
  }
  const elapsed = (now - raw.t) / 1000;
  const decayed = raw.c * Math.max(0, 1 - elapsed / windowSec);
  const newCount = decayed + 1;
  if (newCount > limit) return false;
  await kv.put(`rl:${key}`, JSON.stringify({ c: newCount, t: now }), { expirationTtl: windowSec * 2 });
  return true;
}

// CORS
app.use('*', cors());

// Auth
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status' || c.req.method === 'GET') return next();
  const key = c.req.header('X-Echo-API-Key') || c.req.header('Authorization')?.replace('Bearer ', '');
  if (!key || key !== c.env.ECHO_API_KEY) return c.json({ error: 'Unauthorized' }, 401);
  return next();
});

// Rate limiting
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status') return next();
  const tenant = c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || 'default';
  const limit = c.req.method === 'GET' ? 200 : 60;
  if (!(await rateLimit(c.env.CACHE, `${tenant}:${c.req.method}`, limit))) return c.json({ error: 'Rate limited' }, 429);
  return next();
});

// ── Health ──
app.get('/', (c) => c.redirect('/health'));
app.get('/health', (c) => c.json({ ok: true, service: 'echo-social-media', version: '1.0.0', timestamp: new Date().toISOString() }));
app.get('/status', async (c) => {
  const accounts = await c.env.DB.prepare('SELECT COUNT(*) as c FROM social_accounts').first<{c:number}>();
  const posts = await c.env.DB.prepare('SELECT COUNT(*) as c FROM posts WHERE status=\'published\'').first<{c:number}>();
  return c.json({ ok: true, accounts: accounts?.c || 0, published_posts: posts?.c || 0 });
});

// ── Tenants ──
app.post('/tenants', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO tenants (id,name,plan) VALUES (?,?,?)').bind(id, b.name || 'Default', b.plan || 'starter').run();
  return c.json({ id });
});

// ── Social Accounts ──
app.get('/accounts', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const rows = await c.env.DB.prepare('SELECT id,tenant_id,platform,account_name,account_id,avatar_url,status,follower_count,following_count,post_count,last_synced_at,created_at FROM social_accounts WHERE tenant_id=?').bind(tid).all();
  return c.json({ accounts: rows.results });
});

app.post('/accounts', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const tid = b.tenant_id || 'default';
  const count = await c.env.DB.prepare('SELECT COUNT(*) as c FROM social_accounts WHERE tenant_id=?').bind(tid).first<{c:number}>();
  const tenant = await c.env.DB.prepare('SELECT max_accounts FROM tenants WHERE id=?').bind(tid).first<{max_accounts:number}>();
  if ((count?.c || 0) >= (tenant?.max_accounts || 5)) return c.json({ error: 'Account limit reached' }, 400);
  const id = uid();
  await c.env.DB.prepare('INSERT INTO social_accounts (id,tenant_id,platform,account_name,account_id,avatar_url,access_token,refresh_token) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,platform,account_name) DO UPDATE SET access_token=excluded.access_token, refresh_token=excluded.refresh_token, status=\'active\'')
    .bind(id, tid, b.platform, b.account_name, b.account_id || '', b.avatar_url || '', b.access_token || '', b.refresh_token || '').run();
  return c.json({ id });
});

app.delete('/accounts/:id', async (c) => {
  await c.env.DB.prepare('DELETE FROM social_accounts WHERE id=?').bind(c.req.param('id')).run();
  return c.json({ deleted: true });
});

// ── Posts CRUD ──
app.get('/posts', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const status = c.req.query('status');
  const platform = c.req.query('platform');
  const campaign = c.req.query('campaign_id');
  let sql = 'SELECT * FROM posts WHERE tenant_id=?';
  const params: string[] = [tid];
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (platform) { sql += ' AND platform=?'; params.push(platform); }
  if (campaign) { sql += ' AND campaign_id=?'; params.push(campaign); }
  sql += ' ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 100';
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ posts: rows.results });
});

app.get('/posts/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(c.req.param('id')).first();
  return r ? c.json(r) : c.json({ error: 'Not found' }, 404);
});

app.post('/posts', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  const status = b.scheduled_at ? 'scheduled' : 'draft';
  await c.env.DB.prepare('INSERT INTO posts (id,tenant_id,account_id,platform,content,media_urls,hashtags,status,scheduled_at,campaign_id,labels,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, b.tenant_id || 'default', b.account_id, b.platform, b.content, JSON.stringify(b.media_urls || []), b.hashtags || '', status, b.scheduled_at || null, b.campaign_id || null, b.labels || '', b.created_by || 'system').run();
  if (b.campaign_id) await c.env.DB.prepare('UPDATE campaigns SET total_posts=total_posts+1 WHERE id=?').bind(b.campaign_id).run();
  return c.json({ id, status });
});

app.put('/posts/:id', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const sets: string[] = [];
  const vals: any[] = [];
  if (b.content !== undefined) { sets.push('content=?'); vals.push(b.content); }
  if (b.hashtags !== undefined) { sets.push('hashtags=?'); vals.push(b.hashtags); }
  if (b.media_urls) { sets.push('media_urls=?'); vals.push(JSON.stringify(b.media_urls)); }
  if (b.scheduled_at !== undefined) { sets.push('scheduled_at=?'); vals.push(b.scheduled_at); sets.push('status=\'scheduled\''); }
  if (b.labels !== undefined) { sets.push('labels=?'); vals.push(b.labels); }
  if (sets.length === 0) return c.json({ error: 'No fields' }, 400);
  sets.push('updated_at=datetime(\'now\')');
  vals.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE posts SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
  return c.json({ updated: true });
});

app.delete('/posts/:id', async (c) => {
  const post = await c.env.DB.prepare('SELECT campaign_id FROM posts WHERE id=?').bind(c.req.param('id')).first<{campaign_id:string}>();
  await c.env.DB.prepare('DELETE FROM posts WHERE id=?').bind(c.req.param('id')).run();
  if (post?.campaign_id) await c.env.DB.prepare('UPDATE campaigns SET total_posts=total_posts-1 WHERE id=?').bind(post.campaign_id).run();
  return c.json({ deleted: true });
});

// ── Publish post (simulate — in production would call platform APIs) ──
app.post('/posts/:id/publish', async (c) => {
  const post = await c.env.DB.prepare('SELECT * FROM posts WHERE id=?').bind(c.req.param('id')).first<any>();
  if (!post) return c.json({ error: 'Not found' }, 404);
  if (post.status === 'published') return c.json({ error: 'Already published' }, 400);

  // In production: call platform API to create the post
  // For now: mark as published with a simulated external ID
  const extId = `ext-${uid().slice(0,8)}`;
  await c.env.DB.prepare('UPDATE posts SET status=\'published\', published_at=datetime(\'now\'), external_post_id=?, updated_at=datetime(\'now\') WHERE id=?')
    .bind(extId, post.id).run();
  await c.env.DB.prepare('UPDATE social_accounts SET post_count=post_count+1 WHERE id=?').bind(post.account_id).run();
  return c.json({ published: true, external_post_id: extId });
});

// ── Bulk schedule (cross-post to multiple platforms) ──
app.post('/posts/bulk', async (c) => {
  const b = await c.req.json() as { tenant_id: string; content: string; account_ids: string[]; scheduled_at?: string; hashtags?: string; campaign_id?: string };
  if (!b.account_ids?.length) return c.json({ error: 'account_ids required' }, 400);
  const ids: string[] = [];
  for (const accId of b.account_ids) {
    const acc = await c.env.DB.prepare('SELECT platform FROM social_accounts WHERE id=?').bind(accId).first<{platform:string}>();
    if (!acc) continue;
    const id = uid();
    await c.env.DB.prepare('INSERT INTO posts (id,tenant_id,account_id,platform,content,hashtags,status,scheduled_at,campaign_id) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, b.tenant_id || 'default', accId, acc.platform, sanitize(b.content), b.hashtags || '', b.scheduled_at ? 'scheduled' : 'draft', b.scheduled_at || null, b.campaign_id || null).run();
    ids.push(id);
  }
  return c.json({ created: ids.length, post_ids: ids });
});

// ── Campaigns ──
app.get('/campaigns', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const rows = await c.env.DB.prepare('SELECT * FROM campaigns WHERE tenant_id=? ORDER BY created_at DESC').bind(tid).all();
  return c.json({ campaigns: rows.results });
});

app.post('/campaigns', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO campaigns (id,tenant_id,name,description,start_date,end_date,target_platforms,target_metrics,budget) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, b.tenant_id || 'default', b.name, b.description || '', b.start_date || null, b.end_date || null, JSON.stringify(b.target_platforms || []), JSON.stringify(b.target_metrics || {}), b.budget || 0).run();
  return c.json({ id });
});

app.get('/campaigns/:id', async (c) => {
  const camp = await c.env.DB.prepare('SELECT * FROM campaigns WHERE id=?').bind(c.req.param('id')).first();
  if (!camp) return c.json({ error: 'Not found' }, 404);
  const posts = await c.env.DB.prepare('SELECT id,platform,status,content,likes,comments,shares,impressions,scheduled_at,published_at FROM posts WHERE campaign_id=? ORDER BY COALESCE(scheduled_at,created_at) DESC').bind(c.req.param('id')).all();
  return c.json({ ...camp, posts: posts.results });
});

app.put('/campaigns/:id', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const sets: string[] = [];
  const vals: any[] = [];
  if (b.name) { sets.push('name=?'); vals.push(b.name); }
  if (b.status) { sets.push('status=?'); vals.push(b.status); }
  if (b.description !== undefined) { sets.push('description=?'); vals.push(b.description); }
  if (b.end_date) { sets.push('end_date=?'); vals.push(b.end_date); }
  if (sets.length === 0) return c.json({ error: 'No fields' }, 400);
  vals.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE campaigns SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
  return c.json({ updated: true });
});

// ── Content Calendar ──
app.get('/calendar', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const from = c.req.query('from') || new Date().toISOString().split('T')[0];
  const to = c.req.query('to') || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
  const rows = await c.env.DB.prepare('SELECT * FROM content_calendar WHERE tenant_id=? AND date >= ? AND date <= ? ORDER BY date, time_slot').bind(tid, from, to).all();
  return c.json({ calendar: rows.results });
});

app.post('/calendar', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO content_calendar (id,tenant_id,date,time_slot,platform,content_type,topic,notes,assigned_to) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, b.tenant_id || 'default', b.date, b.time_slot || 'morning', b.platform || null, b.content_type || 'post', b.topic || '', b.notes || '', b.assigned_to || null).run();
  return c.json({ id });
});

app.put('/calendar/:id', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const sets: string[] = [];
  const vals: any[] = [];
  if (b.topic !== undefined) { sets.push('topic=?'); vals.push(b.topic); }
  if (b.status) { sets.push('status=?'); vals.push(b.status); }
  if (b.post_id) { sets.push('post_id=?'); vals.push(b.post_id); }
  if (b.assigned_to !== undefined) { sets.push('assigned_to=?'); vals.push(b.assigned_to); }
  if (sets.length === 0) return c.json({ error: 'No fields' }, 400);
  vals.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE content_calendar SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
  return c.json({ updated: true });
});

// ── Hashtag Groups ──
app.get('/hashtags', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const rows = await c.env.DB.prepare('SELECT * FROM hashtag_groups WHERE tenant_id=? ORDER BY use_count DESC').bind(tid).all();
  return c.json({ hashtag_groups: rows.results });
});

app.post('/hashtags', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO hashtag_groups (id,tenant_id,name,hashtags,category) VALUES (?,?,?,?,?)')
    .bind(id, b.tenant_id || 'default', b.name, b.hashtags, b.category || 'general').run();
  return c.json({ id });
});

// ── Templates ──
app.get('/templates', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const cat = c.req.query('category');
  let sql = 'SELECT * FROM templates WHERE tenant_id=?';
  const params: string[] = [tid];
  if (cat) { sql += ' AND category=?'; params.push(cat); }
  sql += ' ORDER BY use_count DESC';
  const rows = await c.env.DB.prepare(sql).bind(...params).all();
  return c.json({ templates: rows.results });
});

app.post('/templates', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO templates (id,tenant_id,name,platform,content,variables,category) VALUES (?,?,?,?,?,?,?)')
    .bind(id, b.tenant_id || 'default', b.name, b.platform || null, b.content, JSON.stringify(b.variables || []), b.category || 'general').run();
  return c.json({ id });
});

// ── Team ──
app.get('/team', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const rows = await c.env.DB.prepare('SELECT * FROM team_members WHERE tenant_id=?').bind(tid).all();
  return c.json({ members: rows.results });
});

app.post('/team', async (c) => {
  const b = sanitizeBody(await c.req.json()) as any;
  const id = uid();
  await c.env.DB.prepare('INSERT INTO team_members (id,tenant_id,email,name,role) VALUES (?,?,?,?,?)').bind(id, b.tenant_id || 'default', b.email, b.name, b.role || 'editor').run();
  return c.json({ id });
});

// ── Analytics ──
app.get('/analytics/overview', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const accounts = await c.env.DB.prepare('SELECT COUNT(*) as c FROM social_accounts WHERE tenant_id=?').bind(tid).first<{c:number}>();
  const totalFollowers = await c.env.DB.prepare('SELECT SUM(follower_count) as s FROM social_accounts WHERE tenant_id=?').bind(tid).first<{s:number}>();
  const postStats = await c.env.DB.prepare('SELECT COUNT(*) as total, SUM(CASE WHEN status=\'published\' THEN 1 ELSE 0 END) as published, SUM(CASE WHEN status=\'scheduled\' THEN 1 ELSE 0 END) as scheduled, SUM(likes) as total_likes, SUM(comments) as total_comments, SUM(shares) as total_shares, SUM(impressions) as total_impressions FROM posts WHERE tenant_id=?').bind(tid).first<any>();
  const campaigns = await c.env.DB.prepare('SELECT COUNT(*) as c FROM campaigns WHERE tenant_id=? AND status=\'active\'').bind(tid).first<{c:number}>();
  return c.json({
    accounts: accounts?.c || 0,
    total_followers: totalFollowers?.s || 0,
    posts: postStats,
    active_campaigns: campaigns?.c || 0,
  });
});

app.get('/analytics/engagement', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const byPlatform = await c.env.DB.prepare('SELECT platform, COUNT(*) as posts, SUM(likes) as likes, SUM(comments) as comments, SUM(shares) as shares, SUM(impressions) as impressions, AVG(engagement_rate) as avg_engagement FROM posts WHERE tenant_id=? AND status=\'published\' GROUP BY platform').bind(tid).all();
  const topPosts = await c.env.DB.prepare('SELECT id,platform,content,likes,comments,shares,impressions,engagement_rate,published_at FROM posts WHERE tenant_id=? AND status=\'published\' ORDER BY (likes+comments+shares) DESC LIMIT 10').bind(tid).all();
  const daily = await c.env.DB.prepare('SELECT date(published_at) as day, COUNT(*) as posts, SUM(likes+comments+shares) as engagement, SUM(impressions) as impressions FROM posts WHERE tenant_id=? AND status=\'published\' AND published_at > datetime(\'now\',\'-30 days\') GROUP BY day ORDER BY day').bind(tid).all();
  return c.json({ by_platform: byPlatform.results, top_posts: topPosts.results, daily: daily.results });
});

app.get('/analytics/best-times', async (c) => {
  const tid = c.req.query('tenant_id') || 'default';
  const byHour = await c.env.DB.prepare('SELECT strftime(\'%H\',published_at) as hour, AVG(engagement_rate) as avg_engagement, COUNT(*) as posts FROM posts WHERE tenant_id=? AND status=\'published\' AND published_at IS NOT NULL GROUP BY hour ORDER BY avg_engagement DESC').bind(tid).all();
  const byDay = await c.env.DB.prepare('SELECT strftime(\'%w\',published_at) as day_of_week, AVG(engagement_rate) as avg_engagement, COUNT(*) as posts FROM posts WHERE tenant_id=? AND status=\'published\' AND published_at IS NOT NULL GROUP BY day_of_week ORDER BY avg_engagement DESC').bind(tid).all();
  return c.json({ best_hours: byHour.results, best_days: byDay.results });
});

// ── AI: Generate post content ──
app.post('/ai/generate-content', async (c) => {
  const b = await c.req.json() as { topic: string; platform: string; tone?: string; tenant_id?: string };
  if (!b.topic) return c.json({ error: 'topic required' }, 400);
  const charLimits: Record<string, number> = { twitter: 280, linkedin: 3000, instagram: 2200, facebook: 63206 };
  const maxChars = charLimits[b.platform] || 1000;
  const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine_id: 'MKT-01', query: `Write a ${b.platform || 'social media'} post about: ${b.topic}. Tone: ${b.tone || 'professional'}. Max ${maxChars} characters. Include 3-5 relevant hashtags. Return JSON: { "content": "...", "hashtags": "...", "alt_versions": ["...", "..."] }` }),
  });
  return c.json(await resp.json().catch(() => ({ error: 'AI generation failed' })));
});

// ── AI: Suggest hashtags ──
app.post('/ai/suggest-hashtags', async (c) => {
  const b = await c.req.json() as { content: string; platform?: string };
  const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine_id: 'MKT-01', query: `Suggest 10-15 relevant hashtags for this ${b.platform || 'social media'} post: "${b.content}". Group by: high-volume (popular), medium (niche), low-competition (specific). Return JSON: { "high_volume": [...], "medium": [...], "low_competition": [...] }` }),
  });
  return c.json(await resp.json().catch(() => ({ error: 'AI suggestion failed' })));
});

// ── AI: Analyze post performance ──
app.post('/ai/analyze-performance', async (c) => {
  const b = await c.req.json() as { tenant_id: string };
  const posts = await c.env.DB.prepare('SELECT platform,content,likes,comments,shares,impressions,engagement_rate,published_at FROM posts WHERE tenant_id=? AND status=\'published\' ORDER BY published_at DESC LIMIT 50').bind(b.tenant_id).all();
  const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine_id: 'MKT-01', query: `Analyze these social media posts and provide insights: ${JSON.stringify(posts.results)}. Include: 1) Best performing content types, 2) Optimal posting times, 3) Hashtag effectiveness, 4) Content recommendations, 5) Engagement trends. Return structured analysis.` }),
  });
  return c.json(await resp.json().catch(() => ({ error: 'AI analysis failed' })));
});

app.onError((err, c) => {
  if (err.message?.includes('JSON')) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  console.error(`[echo-social-media] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// ── Scheduled handler ──
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Auto-publish scheduled posts that are due
    const duePosts = await env.DB.prepare('SELECT id,account_id FROM posts WHERE status=\'scheduled\' AND scheduled_at <= datetime(\'now\') LIMIT 20').all();
    for (const post of duePosts.results as any[]) {
      const extId = `ext-${crypto.randomUUID().slice(0, 8)}`;
      await env.DB.prepare('UPDATE posts SET status=\'published\', published_at=datetime(\'now\'), external_post_id=?, updated_at=datetime(\'now\') WHERE id=?').bind(extId, post.id).run();
      await env.DB.prepare('UPDATE social_accounts SET post_count=post_count+1 WHERE id=?').bind(post.account_id).run();
    }

    // Cleanup old activity logs
    await env.DB.prepare('DELETE FROM activity_log WHERE created_at < datetime(\'now\',\'-90 days\')').run();
  },
};
