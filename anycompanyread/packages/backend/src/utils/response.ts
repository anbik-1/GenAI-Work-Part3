import { APIGatewayProxyResult } from 'aws-lambda';

/** CORS headers for all responses */
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

/** Return a successful JSON response */
export function success(body: unknown, statusCode = 200): APIGatewayProxyResult {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body),
  };
}

/** Return a created (201) JSON response */
export function created(body: unknown): APIGatewayProxyResult {
  return success(body, 201);
}

/** Return an error JSON response */
export function error(
  message: string,
  statusCode = 500,
  errorCode = 'INTERNAL_ERROR'
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify({ error: errorCode, message }),
  };
}

/** Return a 400 Bad Request */
export function badRequest(message: string): APIGatewayProxyResult {
  return error(message, 400, 'BAD_REQUEST');
}

/** Return a 401 Unauthorized */
export function unauthorized(message = 'Unauthorized'): APIGatewayProxyResult {
  return error(message, 401, 'UNAUTHORIZED');
}

/** Return a 404 Not Found */
export function notFound(message = 'Resource not found'): APIGatewayProxyResult {
  return error(message, 404, 'NOT_FOUND');
}
