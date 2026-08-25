// API Configuration
import { getApiBaseUrl, getWebSocketUrl } from './platform';

export const API_BASE_URL = getApiBaseUrl();
export const WS_URL = `${getWebSocketUrl()}/ws`;
