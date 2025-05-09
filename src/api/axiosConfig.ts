import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse, AxiosError, CancelTokenSource } from 'axios';
import auth from '../utils/auth';

// Track in-flight requests
const pendingRequests = new Map<string, CancelTokenSource>();

/**
 * Centralized API configuration with interceptors for the User Service (port 8081)
 */
const axiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8081', 
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  timeout: 30000 // 30 second timeout
});

/**
 * Separate axios instance for the Recipe Service (port 8082)
 */
export const recipeServiceAxios = axios.create({
  baseURL: 'http://localhost:8082',
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  },
  timeout: 30000 // 30 second timeout
});

// Add interceptor to automatically prepend "/api" to recipe service endpoints
recipeServiceAxios.interceptors.request.use(config => {
  // Check if URL starts with /v1/ but doesn't already have /api/
  if (config.url && config.url.startsWith('/v1/') && !config.url.includes('/api/')) {
    // Replace /v1/ with /api/v1/
    config.url = config.url.replace('/v1/', '/api/v1/');
  }
  return config;
});

// Add ability to cancel pending requests
axiosInstance.cancelPendingRequests = () => {
  pendingRequests.forEach((source, key) => {
    source.cancel('Operation canceled due to new request');
    pendingRequests.delete(key);
  });
};

// Same for recipe service instance
recipeServiceAxios.cancelPendingRequests = () => {
  pendingRequests.forEach((source, key) => {
    if (key.includes('recipe-service')) {
      source.cancel('Operation canceled due to new request');
      pendingRequests.delete(key);
    }
  });
};

// Add custom property types to axios
declare module 'axios' {
  export interface AxiosInstance {
    cancelPendingRequests?: () => void;
  }
  
  export interface InternalAxiosRequestConfig {
    onComplete?: () => void;
  }
}

// Trigger auth state changed event
const triggerAuthStateChanged = (detail = {}) => {
  window.dispatchEvent(new CustomEvent('auth-state-changed', {
    detail: { timestamp: Date.now(), ...detail }
  }));
};

// Request interceptor: add auth headers, deduplicate requests
const setupInterceptors = (instance: typeof axiosInstance, servicePrefix = '') => {
  instance.interceptors.request.use(
    async (config) => {
      // Identify public endpoints
      const isPublicEndpoint = 
        config.url?.includes('/auth/') || 
        config.url?.includes('/public/') ||
        (config.url?.includes('/users') && config.method === 'post');
      
      // Special case for logout requests 
      const isLogoutRequest = config.url?.includes('/auth/logout');
      
      // Handle duplicate requests
      const requestKey = `${servicePrefix}-${config.method}-${config.url}-${JSON.stringify(config.params || {})}`;
      
      if (pendingRequests.has(requestKey) && !isLogoutRequest) {
        const source = pendingRequests.get(requestKey)!;
        source.cancel('Previous duplicate request cancelled');
        pendingRequests.delete(requestKey);
      }
      
      // Create cancel token for this request
      const source = axios.CancelToken.source();
      config.cancelToken = config.cancelToken || source.token;
      pendingRequests.set(requestKey, source);
      
      // Add cleanup function
      const originalComplete = config.onComplete;
      config.onComplete = () => {
        pendingRequests.delete(requestKey);
        if (originalComplete) originalComplete();
      };
      
      // Add auth token for protected endpoints
      if (!isPublicEndpoint || isLogoutRequest) {
        if (!auth.isTokenValid() && !isLogoutRequest) {
          source.cancel('No valid authentication');
          return Promise.reject({ cancelled: true });
        }
        
        const token = auth.getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      }
      
      // Check if the URL is for recipe service
      if (config.url && (
        config.url.includes('/api/v1/recipes') || 
        config.url.includes('/api/v1/favorites')
      )) {
        config.baseURL = 'http://localhost:8082'; // Recipe service
      }
      
      return config;
    },
    error => Promise.reject(error)
  );

  // Response interceptor: handle errors, tokens, and cleanup
  instance.interceptors.response.use(
    (response: AxiosResponse) => {
      // Clean up request tracking
      if (response.config.onComplete) {
        response.config.onComplete();
      }
      
      // Process auth tokens
      const authToken = response.data?.token || 
                      response.headers['x-auth-token'] || 
                      response.headers['authorization'] ||
                      response.headers['Authorization'];
                      
      if (authToken) {
        const rawToken = authToken.startsWith('Bearer ') 
          ? authToken.substring(7) 
          : authToken;
          
        auth.setToken(rawToken);
      }
      
      return response;
    },
    (error: any) => {
      // Clean up request tracking
      if (error.config?.onComplete) {
        error.config.onComplete();
      }
      
      // Handle cancelled requests
      if (axios.isCancel(error) || error.cancelled) {
        return Promise.reject({
          isCancel: true,
          isCancelled: true,
          message: error.message || 'Request cancelled'
        });
      }
      
      // Handle network errors
      if (!error.response) {
        window.dispatchEvent(new CustomEvent('api-network-error', {
          detail: { message: error.message }
        }));
      }
      
      // Handle auth errors
      if (error.response?.status === 401) {
        auth.removeToken();
        triggerAuthStateChanged({ reason: 'unauthorized' });
      } 
      else if (error.response?.status === 403 && !error.config?.url?.includes('/profile')) {
        triggerAuthStateChanged({ reason: 'forbidden' });
      }
      
      return Promise.reject(error);
    }
  );
};

// Apply interceptors to both instances
setupInterceptors(axiosInstance, 'user-service');
setupInterceptors(recipeServiceAxios, 'recipe-service');

export default axiosInstance; 