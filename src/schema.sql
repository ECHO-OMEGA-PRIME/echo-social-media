-- Echo Social Media Manager v1.0.0
-- Multi-platform social media scheduling, analytics, and AI content generation

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT DEFAULT 'starter',
  max_accounts INTEGER DEFAULT 5,
  max_posts_per_day INTEGER DEFAULT 20,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  platform TEXT NOT NULL, -- twitter, linkedin, instagram, facebook, reddit, tiktok, youtube, threads
  account_name TEXT NOT NULL,
  account_id TEXT,
  avatar_url TEXT,
  access_token TEXT, -- encrypted
  refresh_token TEXT,
  token_expires_at TEXT,
  status TEXT DEFAULT 'active', -- active, expired, revoked, error
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  last_synced_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_tenant ON social_accounts(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_unique ON social_accounts(tenant_id, platform, account_name);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  content TEXT NOT NULL,
  media_urls TEXT DEFAULT '[]', -- JSON array of media URLs
  hashtags TEXT DEFAULT '',
  status TEXT DEFAULT 'draft', -- draft, scheduled, published, failed, cancelled
  scheduled_at TEXT,
  published_at TEXT,
  external_post_id TEXT, -- ID on the social platform
  external_url TEXT, -- Direct link to the post
  error_message TEXT,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  engagement_rate REAL DEFAULT 0,
  campaign_id TEXT,
  labels TEXT DEFAULT '',
  created_by TEXT DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_tenant ON posts(tenant_id);
CREATE INDEX IF NOT EXISTS idx_posts_account ON posts(account_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_posts_scheduled ON posts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_posts_campaign ON posts(campaign_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active', -- active, paused, completed, archived
  start_date TEXT,
  end_date TEXT,
  target_platforms TEXT DEFAULT '[]', -- JSON array
  target_metrics TEXT DEFAULT '{}', -- JSON: { impressions: 10000, engagement_rate: 5 }
  total_posts INTEGER DEFAULT 0,
  total_impressions INTEGER DEFAULT 0,
  total_engagement INTEGER DEFAULT 0,
  budget REAL DEFAULT 0,
  spent REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant ON campaigns(tenant_id);

CREATE TABLE IF NOT EXISTS content_calendar (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  date TEXT NOT NULL,
  time_slot TEXT, -- morning, afternoon, evening, custom HH:MM
  platform TEXT,
  content_type TEXT DEFAULT 'post', -- post, story, reel, thread, poll
  topic TEXT,
  notes TEXT,
  post_id TEXT, -- linked post after creation
  status TEXT DEFAULT 'planned', -- planned, drafted, assigned, published
  assigned_to TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_calendar_tenant_date ON content_calendar(tenant_id, date);

CREATE TABLE IF NOT EXISTS hashtag_groups (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  hashtags TEXT NOT NULL, -- comma-separated
  category TEXT DEFAULT 'general',
  use_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hashtags_tenant ON hashtag_groups(tenant_id);

CREATE TABLE IF NOT EXISTS analytics_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  date TEXT NOT NULL,
  followers INTEGER DEFAULT 0,
  following INTEGER DEFAULT 0,
  posts_published INTEGER DEFAULT 0,
  total_impressions INTEGER DEFAULT 0,
  total_engagement INTEGER DEFAULT 0,
  total_clicks INTEGER DEFAULT 0,
  avg_engagement_rate REAL DEFAULT 0,
  top_post_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_analytics_tenant_date ON analytics_snapshots(tenant_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_unique ON analytics_snapshots(account_id, date);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT, -- null = all platforms
  content TEXT NOT NULL,
  variables TEXT DEFAULT '[]', -- JSON: ["company_name", "product"]
  category TEXT DEFAULT 'general',
  use_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant_id);

CREATE TABLE IF NOT EXISTS team_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'editor', -- admin, editor, viewer
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_team_tenant ON team_members(tenant_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT,
  performed_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
