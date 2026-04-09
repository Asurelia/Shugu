/**
 * Credentials: Provider
 *
 * High-level API for tools to request credentials.
 * Tools NEVER see the vault directly — they ask the provider for a token
 * and get back a string (or null if not configured).
 *
 * SECURITY: Credentials are NEVER injected into LLM context.
 * Only the tool's execution result (e.g., API response content) is returned.
 */

import { CredentialVault } from './vault.js';
import type { ServiceType, Credential } from './types.js';
import { SERVICE_TEMPLATES } from './types.js';

// ─── Credential Provider ────────────────────────────────

export class CredentialProvider {
  private vault: CredentialVault;

  constructor(vault: CredentialVault) {
    this.vault = vault;
  }

  /**
   * Get a token/API key for a service.
   * Returns null if not configured.
   */
  getToken(service: ServiceType): string | null {
    if (!this.vault?.isUnlocked) return null;
    return this.vault.getValue(service, 'token') ?? null;
  }

  /**
   * Get all values for a service credential.
   */
  getCredential(service: ServiceType): Record<string, string> | null {
    if (!this.vault?.isUnlocked) return null;
    const cred = this.vault.get(service);
    return cred?.values ?? null;
  }

  /**
   * Get auth headers for HTTP requests to a given URL.
   * Auto-detects the service from the domain and returns appropriate headers.
   */
  getAuthHeaders(url: string): Record<string, string> {
    if (!this.vault?.isUnlocked) return {};

    const domain = extractDomain(url);
    if (!domain) return {};

    // Check domain-matched credential
    const cred = this.vault.getByDomain(domain);
    if (!cred) return {};

    return buildAuthHeaders(cred);
  }

  /**
   * Check if a service has configured credentials.
   */
  hasCredential(service: ServiceType): boolean {
    if (!this.vault?.isUnlocked) return false;
    return this.vault.get(service) !== undefined;
  }

  /**
   * Get SSH connection info for VPS.
   */
  getVPSConfig(): VPSConfig | null {
    if (!this.vault?.isUnlocked) return null;
    const cred = this.vault.get('vps');
    if (!cred) return null;

    return {
      host: cred.values['host'] ?? '',
      user: cred.values['user'] ?? 'root',
      keyPath: cred.values['key_path'] ?? '',
      port: parseInt(cred.values['port'] ?? '22', 10),
    };
  }

  get isAvailable(): boolean {
    return this.vault?.isUnlocked ?? false;
  }
}

export interface VPSConfig {
  host: string;
  user: string;
  keyPath: string;
  port: number;
}

// ─── Auth Header Building ───────────────────────────────

function buildAuthHeaders(cred: Credential): Record<string, string> {
  const token = cred.values['token'];
  if (!token) return {};

  switch (cred.service) {
    case 'github':
      return { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' };

    case 'gitlab':
      return { 'PRIVATE-TOKEN': token };

    case 'vercel':
      return { 'Authorization': `Bearer ${token}` };

    case 'supabase':
      return { 'Authorization': `Bearer ${token}`, 'apikey': token };

    case 'cloudflare':
      return { 'Authorization': `Bearer ${token}` };

    case 'notion':
      return { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' };

    case 'slack':
      return { 'Authorization': `Bearer ${token}` };

    default:
      return { 'Authorization': `Bearer ${token}` };
  }
}

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}
