import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { signup } from './signup';
import { login } from './login';
import { forgotPassword } from './forgot-password';
import { confirmForgotPassword } from './confirm-forgot-password';
import { badRequest } from '../../utils/response';
import { handleError } from '../../utils/error';

/**
 * Auth Lambda handler — routes requests to appropriate auth function
 * based on the HTTP method and path.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const path = event.path;
    const method = event.httpMethod;

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type,Authorization', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' }, body: '' };
    }

    if (method === 'POST') {
      if (path.endsWith('/signup')) return await signup(event);
      if (path.endsWith('/login')) return await login(event);
      if (path.endsWith('/forgot-password')) return await forgotPassword(event);
      if (path.endsWith('/confirm-forgot-password')) return await confirmForgotPassword(event);
    }

    return badRequest(`Unsupported route: ${method} ${path}`);
  } catch (err) {
    return handleError(err);
  }
}
