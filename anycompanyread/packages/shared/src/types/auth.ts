/** Signup request payload */
export interface SignupRequest {
  email: string;
  password: string;
  name: string;
}

/** Login request payload */
export interface LoginRequest {
  email: string;
  password: string;
}

/** Login response with JWT tokens */
export interface LoginResponse {
  idToken: string;
  accessToken: string;
  refreshToken: string;
}

/** Forgot password request */
export interface ForgotPasswordRequest {
  email: string;
}

/** Confirm forgot password request */
export interface ConfirmForgotPasswordRequest {
  email: string;
  code: string;
  newPassword: string;
}

/** Generic message response */
export interface MessageResponse {
  message: string;
}
