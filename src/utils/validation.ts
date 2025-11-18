import { ValidationResult } from '../types/validation';

export function validateNodeName(name: any): ValidationResult {
  if (typeof name !== 'string') {
    return { isValid: false, error: 'Name must be a string' };
  }
  if (name.length === 0 || name.length > 50) {
    return { isValid: false, error: 'Name must be between 1 and 50 characters' };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return { isValid: false, error: 'Name contains invalid characters. Only alphanumeric, dots, underscores and hyphens allowed' };
  }
  return { isValid: true };
}

export function validateHost(host: any): ValidationResult {
  if (typeof host !== 'string') {
    return { isValid: false, error: 'Host must be a string' };
  }
  if (host.length === 0 || host.length > 253) {
    return { isValid: false, error: 'Host must be between 1 and 253 characters' };
  }
  // Basic hostname/IP validation
  const hostnameRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  
  if (!hostnameRegex.test(host) && !ipRegex.test(host)) {
    return { isValid: false, error: 'Invalid hostname or IP address format' };
  }
  return { isValid: true };
}

export function validatePort(port: any): ValidationResult {
  const numPort = Number(port);
  if (!Number.isInteger(numPort)) {
    return { isValid: false, error: 'Port must be an integer' };
  }
  if (numPort < 1 || numPort > 65535) {
    return { isValid: false, error: 'Port must be between 1 and 65535' };
  }
  return { isValid: true };
}