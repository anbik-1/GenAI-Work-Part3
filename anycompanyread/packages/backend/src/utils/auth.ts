import { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Extract the authenticated user's ID (sub) from the API Gateway request context.
 * The Cognito authorizer populates claims in the request context.
 */
export function getUserId(event: APIGatewayProxyEvent): string | null {
  const claims = event.requestContext.authorizer?.claims;
  if (!claims) return null;
  return claims.sub || claims['cognito:username'] || null;
}

/**
 * Extract the user's email from Cognito claims.
 */
export function getUserEmail(event: APIGatewayProxyEvent): string | null {
  const claims = event.requestContext.authorizer?.claims;
  if (!claims) return null;
  return claims.email || null;
}
