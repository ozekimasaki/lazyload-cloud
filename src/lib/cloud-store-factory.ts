/**
 * Cloud store factory: selects between Worker-based and direct Cloudflare access.
 */
import type { CloudStore, DirectCloudflareConfig, RemoteMode, ResolvedRuntimeConfig } from '../types.js';
import { createDirectCloudStore } from './direct-cloud-store.js';

/**
 * Returns true when all fields required for direct D1/R2 access are present.
 */
export function isDirectConfigComplete(
  resolved: ResolvedRuntimeConfig['resolved']
): resolved is ResolvedRuntimeConfig['resolved'] & {
  accountId: { value: string };
  d1DatabaseId: { value: string };
  r2Bucket: { value: string };
  r2AccessKeyId: { value: string };
  r2SecretAccessKey: { value: string };
} {
  return !!(
    resolved.accountId.value &&
    resolved.d1DatabaseId.value &&
    resolved.r2Bucket.value &&
    resolved.r2AccessKeyId.value &&
    resolved.r2SecretAccessKey.value
  );
}

/**
 * Extracts a DirectCloudflareConfig from resolved runtime config.
 * Throws if any required field is missing.
 */
export function directConfigFromResolved(resolved: ResolvedRuntimeConfig['resolved']): DirectCloudflareConfig {
  if (!isDirectConfigComplete(resolved)) {
    const missing: string[] = [];
    if (!resolved.accountId.value) missing.push('accountId (LAZYLOAD_ACCOUNT_ID)');
    if (!resolved.d1DatabaseId.value) missing.push('d1DatabaseId (LAZYLOAD_D1_DATABASE_ID)');
    if (!resolved.r2Bucket.value) missing.push('r2Bucket (LAZYLOAD_R2_BUCKET)');
    if (!resolved.r2AccessKeyId.value) missing.push('r2AccessKeyId (LAZYLOAD_R2_ACCESS_KEY_ID)');
    if (!resolved.r2SecretAccessKey.value) missing.push('r2SecretAccessKey (LAZYLOAD_R2_SECRET_ACCESS_KEY)');
    throw new Error(
      `Direct Cloudflare mode is missing required credentials: ${missing.join(', ')}. ` +
      'Run `lazyload-cloud auth login` or set the corresponding environment variables.'
    );
  }

  return {
    accountId: resolved.accountId.value,
    d1DatabaseId: resolved.d1DatabaseId.value,
    r2Bucket: resolved.r2Bucket.value,
    r2AccessKeyId: resolved.r2AccessKeyId.value,
    r2SecretAccessKey: resolved.r2SecretAccessKey.value,
    cloudflareApiToken: resolved.cloudflareApiToken.value,
  };
}

/**
 * Detects which remote mode is active based on resolved config.
 */
export function detectRemoteMode(resolved: ResolvedRuntimeConfig['resolved']): RemoteMode {
  return resolved.remoteMode.value;
}

/**
 * Creates a CloudStore for direct Cloudflare access.
 * Use this when `detectRemoteMode` returns 'direct'.
 */
export function createCloudStoreForDirectMode(resolved: ResolvedRuntimeConfig['resolved']): CloudStore {
  return createDirectCloudStore(directConfigFromResolved(resolved));
}
