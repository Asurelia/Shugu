/**
 * Credentials: barrel export
 */

export { CredentialVault } from './vault.js';
export { CredentialProvider, type VPSConfig } from './provider.js';
export { SERVICE_TEMPLATES, type Credential, type ServiceType, type ServiceTemplate } from './types.js';
export {
  VaultError, WrongPasswordError, CorruptedVaultError,
  VaultNotFoundError, VaultDiskError, VaultAlreadyExistsError,
  isVaultError, type VaultErrorCode,
} from './errors.js';
export {
  promptPassword, promptText,
  PasswordMismatchError, EmptyPasswordError, NoTTYError,
} from './prompt.js';
