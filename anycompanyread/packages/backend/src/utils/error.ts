import { APIGatewayProxyResult } from 'aws-lambda';
import { error } from './response';

/**
 * Wraps a handler function with consistent error handling.
 * Catches unhandled errors and returns a 500 response.
 */
export function handleError(err: unknown): APIGatewayProxyResult {
  console.error('Unhandled error:', err);

  if (err instanceof Error) {
    // Handle known AWS SDK errors
    const name = err.name;

    if (name === 'UserNotFoundException' || name === 'ResourceNotFoundException') {
      return error('Resource not found', 404, 'NOT_FOUND');
    }
    if (name === 'UsernameExistsException') {
      return error('An account with this email already exists', 409, 'CONFLICT');
    }
    if (name === 'NotAuthorizedException') {
      return error('Invalid credentials', 401, 'UNAUTHORIZED');
    }
    if (name === 'InvalidParameterException' || name === 'InvalidPasswordException') {
      return error(err.message, 400, 'BAD_REQUEST');
    }
    if (name === 'CodeMismatchException' || name === 'ExpiredCodeException') {
      return error('Invalid or expired verification code', 400, 'BAD_REQUEST');
    }
    if (name === 'ConditionalCheckFailedException') {
      return error('Item already exists or condition not met', 409, 'CONFLICT');
    }

    return error(err.message, 500, 'INTERNAL_ERROR');
  }

  return error('An unexpected error occurred', 500, 'INTERNAL_ERROR');
}
