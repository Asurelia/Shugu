/**
 * Credentials: Type definitions
 *
 * Credentials are NEVER sent to the LLM context.
 * Only tools use them internally for authenticated requests.
 */

// ─── Service Types ──────────────────────────────────────

export type ServiceType =
  // Code hosting
  | 'github' | 'gitlab' | 'bitbucket'
  // Cloud
  | 'aws' | 'gcp' | 'azure' | 'vercel' | 'supabase' | 'netlify' | 'railway' | 'fly'
  // Communication
  | 'gmail' | 'slack' | 'discord' | 'notion'
  // Infrastructure
  | 'cloudflare' | 'vps'
  // Generic
  | 'custom';

// ─── Credential Entry ───────────────────────────────────

export interface Credential {
  service: ServiceType;
  /** Human-readable label (e.g., "personal github", "work aws") */
  label: string;
  /** Key-value pairs for this credential */
  values: Record<string, string>;
  /** When this credential was added */
  addedAt: string;
  /** Optional: domains this credential applies to */
  domains?: string[];
}

// ─── Service Templates ──────────────────────────────────

export interface ServiceTemplate {
  service: ServiceType;
  description: string;
  fields: Array<{
    key: string;
    label: string;
    secret: boolean;
    hint?: string;
  }>;
  domains: string[];
}

export const SERVICE_TEMPLATES: Record<string, ServiceTemplate> = {
  github: {
    service: 'github',
    description: 'GitHub Personal Access Token',
    fields: [
      { key: 'token', label: 'Token (ghp_...)', secret: true, hint: 'Settings → Developer settings → Personal access tokens' },
      { key: 'username', label: 'Username', secret: false },
    ],
    domains: ['github.com', 'api.github.com'],
  },
  gitlab: {
    service: 'gitlab',
    description: 'GitLab Personal Access Token',
    fields: [
      { key: 'token', label: 'Token (glpat-...)', secret: true },
      { key: 'url', label: 'Instance URL', secret: false, hint: 'Default: https://gitlab.com' },
    ],
    domains: ['gitlab.com'],
  },
  aws: {
    service: 'aws',
    description: 'AWS Access Credentials',
    fields: [
      { key: 'access_key_id', label: 'Access Key ID', secret: false },
      { key: 'secret_access_key', label: 'Secret Access Key', secret: true },
      { key: 'region', label: 'Default Region', secret: false, hint: 'e.g., eu-west-1' },
    ],
    domains: ['amazonaws.com', 'aws.amazon.com'],
  },
  vercel: {
    service: 'vercel',
    description: 'Vercel Token',
    fields: [
      { key: 'token', label: 'Token', secret: true, hint: 'Settings → Tokens' },
    ],
    domains: ['vercel.com', 'api.vercel.com'],
  },
  supabase: {
    service: 'supabase',
    description: 'Supabase Access Token',
    fields: [
      { key: 'token', label: 'Access Token', secret: true },
      { key: 'project_ref', label: 'Project Reference', secret: false },
    ],
    domains: ['supabase.com', 'supabase.co'],
  },
  cloudflare: {
    service: 'cloudflare',
    description: 'Cloudflare API Token',
    fields: [
      { key: 'token', label: 'API Token', secret: true },
      { key: 'account_id', label: 'Account ID', secret: false },
    ],
    domains: ['cloudflare.com', 'api.cloudflare.com'],
  },
  gmail: {
    service: 'gmail',
    description: 'Gmail App Password',
    fields: [
      { key: 'email', label: 'Email address', secret: false },
      { key: 'app_password', label: 'App Password', secret: true, hint: 'Google Account → Security → App passwords' },
    ],
    domains: ['gmail.com', 'mail.google.com'],
  },
  notion: {
    service: 'notion',
    description: 'Notion Integration Token',
    fields: [
      { key: 'token', label: 'Internal Integration Token (secret_...)', secret: true },
    ],
    domains: ['notion.so', 'api.notion.com'],
  },
  slack: {
    service: 'slack',
    description: 'Slack Bot Token',
    fields: [
      { key: 'token', label: 'Bot Token (xoxb-...)', secret: true },
    ],
    domains: ['slack.com', 'api.slack.com'],
  },
  discord: {
    service: 'discord',
    description: 'Discord Bot Token',
    fields: [
      { key: 'token', label: 'Bot Token', secret: true },
    ],
    domains: ['discord.com', 'discord.gg'],
  },
  vps: {
    service: 'vps',
    description: 'VPS SSH Access',
    fields: [
      { key: 'host', label: 'Host (IP or domain)', secret: false },
      { key: 'user', label: 'SSH User', secret: false },
      { key: 'key_path', label: 'SSH Key Path', secret: false, hint: 'e.g., ~/.ssh/id_ed25519' },
      { key: 'port', label: 'SSH Port', secret: false, hint: 'Default: 22' },
    ],
    domains: [],
  },
  custom: {
    service: 'custom',
    description: 'Custom API Key',
    fields: [
      { key: 'name', label: 'Service name', secret: false },
      { key: 'token', label: 'API Key / Token', secret: true },
      { key: 'base_url', label: 'Base URL', secret: false },
    ],
    domains: [],
  },
};
